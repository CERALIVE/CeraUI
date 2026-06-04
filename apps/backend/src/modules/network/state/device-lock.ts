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
 * `withModemUpdateLock` is a single global re-entrancy guard for the modem
 * update loop. Re-entrant calls are dropped (logged) rather than queued, so
 * concurrent modem polls can never stack on top of each other.
 *
 * Intentionally minimal: a `Map<deviceId, boolean>` in-flight registry plus a
 * single boolean for the modem loop. No queue, no scheduler, no dependencies.
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

/** Single global guard for the modem update loop. */
let modemUpdateInFlight = false;

/**
 * Serialize the modem update loop against itself. A re-entrant call (while a
 * previous `fn` is still running) is dropped and logged — it does NOT throw,
 * does NOT queue, and does NOT deadlock. Releases in a `finally`.
 */
export async function withModemUpdateLock(
	fn: () => Promise<void>,
): Promise<void> {
	if (modemUpdateInFlight) {
		logger.debug("Modem update already in progress, dropping re-entrant call");
		return;
	}

	modemUpdateInFlight = true;
	try {
		await fn();
	} finally {
		modemUpdateInFlight = false;
	}
}
