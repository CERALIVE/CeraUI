/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Per-device async conflict guard.
 *
 * `withDeviceLock` serializes operations against a single device id (e.g. an
 * interface name like `wlan0`). When the device is free it acquires the lock,
 * runs `fn`, and releases the lock in a `finally` (so it never deadlocks, even
 * on throw). When the device is already busy it returns `DEVICE_BUSY`
 * immediately WITHOUT invoking `fn` — the conflict contract that the RPC layer
 * relies on.
 *
 * `withModemUpdateLock` is a single global trailing scheduler for the modem
 * update loop. Concurrent requests coalesce into one latest-state follow-up.
 *
 * Intentionally minimal: a `Map<deviceId, boolean>` in-flight registry plus a
 * one pending callback for the modem loop.
 */

import { logger } from "../../../helpers/logger.ts";

export type DeviceLockResult<T> =
	| { success: true; result: T }
	| { success: false; error: "DEVICE_BUSY" };

/** In-flight registry: deviceId -> true while an operation holds the lock. */
const inFlight = new Map<string, boolean>();

/**
 * Run `fn` while holding an exclusive lock on `deviceId`.
 *
 * - Free device: acquires lock, runs `fn`, releases on success OR throw.
 * - Busy device: returns `{ success: false, error: "DEVICE_BUSY" }` immediately;
 *   `fn` is NOT called.
 */
export async function withDeviceLock<T>(
	deviceId: string,
	fn: () => Promise<T>,
): Promise<DeviceLockResult<T>> {
	if (inFlight.get(deviceId)) {
		logger.debug(`Device ${deviceId} is busy, rejecting concurrent operation`);
		return { success: false, error: "DEVICE_BUSY" };
	}

	inFlight.set(deviceId, true);
	try {
		const result = await fn();
		return { success: true, result };
	} finally {
		inFlight.delete(deviceId);
	}
}

let modemUpdateDrain: Promise<void> | undefined;
let trailingModemUpdate: (() => Promise<void>) | undefined;

/**
 * Serialize modem work and retain exactly one latest-state follow-up while a
 * run is active. Every coalesced caller joins the same bounded drain.
 */
export async function withModemUpdateLock(
	fn: () => Promise<void>,
): Promise<void> {
	if (modemUpdateDrain !== undefined) {
		trailingModemUpdate = fn;
		logger.debug("Modem update already in progress, coalescing trailing run");
		return modemUpdateDrain;
	}

	const drain = Promise.resolve().then(async () => {
		let next: (() => Promise<void>) | undefined = fn;
		let firstFailure: unknown;
		let failed = false;
		while (next !== undefined) {
			try {
				await next();
			} catch (error) {
				if (!failed) firstFailure = error;
				failed = true;
			}
			next = trailingModemUpdate;
			trailingModemUpdate = undefined;
		}
		if (failed) throw firstFailure;
	});
	modemUpdateDrain = drain;
	try {
		await drain;
	} finally {
		if (modemUpdateDrain === drain) modemUpdateDrain = undefined;
	}
}
