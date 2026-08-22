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

/**
 * PER-ADAPTER mutation guard (S5) + the journal-style pending stamp (S7).
 *
 * Every mutation this module performs — power, discovery, pair, trust, forget,
 * connect — is a write against ONE shared piece of host state: the controller.
 * BlueZ serialises some of it internally and fails the rest in ways that are
 * hard to attribute (`org.bluez.Error.InProgress`, `AlreadyExists`, a discovery
 * that stops itself mid-pair), so the guard is here rather than left to the
 * daemon.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SECOND CONCURRENT MUTATION IS REFUSED, NOT QUEUED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The refusal is the contract, and it is deliberate: a queue makes an operator's
 * second tap land at an unpredictable moment against a device whose state the
 * first tap already changed — a "Forget" queued behind a "Pair" completes by
 * forgetting the device that was just paired, seconds after the operator stopped
 * looking. `ADAPTER_BUSY` names the op that holds the lock, so the caller can say
 * WHAT is in progress instead of a generic "device busy".
 *
 * The key is the ADAPTER path (`/org/bluez/hci0`), not the device path: two
 * devices on one controller contend for the same radio, so a per-device lock
 * would let a pair and a discovery run concurrently on it. A board with two
 * controllers gets two independent locks, which is the point of keying on the
 * adapter rather than taking one global lock.
 *
 * Shape deliberately mirrors `modules/network/state/device-lock.ts`
 * (`withDeviceLock`): a `Map` in-flight registry, release in a `finally` so a
 * throw can never wedge the adapter, and NO queue/scheduler. It is a separate
 * registry because the key spaces are different — an interface name and a BlueZ
 * object path must never collide.
 */

import { logger } from "../../helpers/logger.ts";

import type {
	BluetoothMutation,
	PendingMutation,
} from "./bluetooth-registry.ts";

export const ADAPTER_BUSY = "ADAPTER_BUSY" as const;

export type AdapterLockResult<T> =
	| { readonly success: true; readonly result: T }
	| {
			readonly success: false;
			readonly error: typeof ADAPTER_BUSY;
			/** The mutation currently holding the adapter. */
			readonly heldBy: BluetoothMutation;
	  };

/** In-flight registry: adapter object path → the mutation holding it. */
const inFlight = new Map<string, PendingMutation>();

/** Clock seam so a pending stamp is assertable without a fake timer. */
let now: () => number = () => Date.now();

/** Test seam (the `set*ForTest` convention). Pass `null` to restore `Date.now`. */
export function setAdapterLockClockForTest(clock: (() => number) | null): void {
	now = clock ?? (() => Date.now());
}

/** The mutation currently holding `adapterPath`, or `undefined` when free. */
export function pendingOnAdapter(
	adapterPath: string,
): PendingMutation | undefined {
	return inFlight.get(adapterPath);
}

/**
 * Run `fn` while holding an exclusive lock on `adapterPath`.
 *
 * - Free adapter: acquires, stamps the pending record, runs `fn`, releases on
 *   success OR throw.
 * - Busy adapter: returns `{ success:false, error:"ADAPTER_BUSY", heldBy }`
 *   IMMEDIATELY; `fn` is NOT called and nothing is queued.
 *
 * `onPending` is the S7 seam: it is called with the pending record on
 * acquisition and with `undefined` on release, so the registry row carries an
 * in-flight marker for exactly the window the lock is held — and cannot be left
 * marked by a throw, because the release is in the `finally`.
 */
export async function withAdapterLock<T>(
	adapterPath: string,
	op: BluetoothMutation,
	fn: () => Promise<T>,
	onPending?: (pending: PendingMutation | undefined) => void,
): Promise<AdapterLockResult<T>> {
	const held = inFlight.get(adapterPath);
	if (held !== undefined) {
		logger.debug(
			`bluetooth: adapter ${adapterPath} busy with ${held.op}; refusing ${op}`,
		);
		return { success: false, error: ADAPTER_BUSY, heldBy: held.op };
	}

	const pending: PendingMutation = { op, startedAtMs: now() };
	inFlight.set(adapterPath, pending);
	onPending?.(pending);
	try {
		const result = await fn();
		return { success: true, result };
	} finally {
		inFlight.delete(adapterPath);
		onPending?.(undefined);
	}
}

/** Drop every held lock. Test isolation only — never call from production code. */
export function resetAdapterLocks(): void {
	inFlight.clear();
}
