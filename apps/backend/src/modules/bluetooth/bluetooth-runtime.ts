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
 * The LIVE wiring of the Bluetooth stack: one process-wide instance, its boot
 * start, and the `bluetooth` broadcast.
 *
 * This is the first thing that runs todo 12's module for real. Everything below
 * it stays exactly as that module built it — the S5 per-adapter lock, the S7
 * pending stamps, the bounded discovery window and the typed degradations are
 * all applied INSIDE the stack, so nothing here re-implements any of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BROADCAST IS ON-CHANGE AND TRAILING-DEBOUNCED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `BluetoothStack`'s `onChange` fires on every registry edge, and a discovery
 * window turns every advertisement into one — an RSSI that moved is a real edge
 * and would otherwise be a broadcast per advertisement per device. So edges are
 * collapsed onto a trailing {@link BLUETOOTH_BROADCAST_DEBOUNCE_MS} timer and
 * the payload is compared before it is sent, which is the same on-change cadence
 * the `sources` broadcast follows. The timer is `unref`'d: a scan window must
 * never hold the event loop open.
 */

import { logger } from "../../helpers/logger.ts";
import { broadcastMsg } from "../../rpc/compat.ts";

import { initBluetoothPreferenceStore } from "./bluetooth-preference.ts";
import {
	BluetoothStack,
	defaultBluetoothStackDeps,
} from "./bluetooth-stack.ts";
import { buildBluetoothStatus } from "./bluetooth-wire.ts";

/** The broadcast channel. Its own type, like `wifi` and `modems`. */
export const BLUETOOTH_EVENT = "bluetooth" as const;

/** Collapse a burst of registry edges (a discovery window) into one send. */
export const BLUETOOTH_BROADCAST_DEBOUNCE_MS = 250;

let stack: BluetoothStack | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastPayload: string | undefined;

/**
 * The live stack, built on first use.
 *
 * Lazy rather than boot-only so a read (`bluetooth.getStatus`) issued before —
 * or instead of — the boot phase still answers with the module's own typed
 * "the stack has not started" state rather than throwing at an RPC boundary.
 */
export function getBluetoothStack(): BluetoothStack {
	if (stack === undefined) {
		stack = new BluetoothStack({
			...defaultBluetoothStackDeps,
			onChange: scheduleBluetoothBroadcast,
		});
	}
	return stack;
}

/** The `bluetooth` payload for the initial-state push and the broadcast alike. */
export function getBluetoothStatusMessage(): ReturnType<
	typeof buildBluetoothStatus
> {
	return buildBluetoothStatus(getBluetoothStack().state());
}

/** Broadcast immediately, but only when the payload actually moved. */
export function broadcastBluetoothIfChanged(): void {
	let payload: ReturnType<typeof buildBluetoothStatus>;
	try {
		payload = getBluetoothStatusMessage();
	} catch (err) {
		logger.warn(`bluetooth: could not build the wire payload: ${String(err)}`);
		return;
	}
	const serialized = JSON.stringify(payload);
	if (serialized === lastPayload) return;
	lastPayload = serialized;
	broadcastMsg(BLUETOOTH_EVENT, payload);
}

/** Collapse an edge burst onto one trailing send. */
export function scheduleBluetoothBroadcast(): void {
	if (debounceTimer !== undefined) return;
	debounceTimer = setTimeout(() => {
		debounceTimer = undefined;
		broadcastBluetoothIfChanged();
	}, BLUETOOTH_BROADCAST_DEBOUNCE_MS);
	debounceTimer.unref?.();
}

/**
 * Bring Bluetooth up at boot.
 *
 * NEVER throws: `BluetoothStack.start()` resolves every failure into a typed
 * `bt_unavailable`, and the caller is a `guardNonCritical` phase — Bluetooth is
 * not on the boot critical path, so a board with no controller (or with
 * `bluetoothd` masked) must still reach its UI.
 */
export async function initBluetooth(): Promise<void> {
	// The preference store is inert until it is pointed at a directory; the
	// stack reads it to decide whether to observe BlueZ at all, so this must
	// precede `start()`.
	initBluetoothPreferenceStore();

	const state = await getBluetoothStack().start();
	if (state.available) {
		logger.info(
			`bluetooth: stack up with ${state.adapters.length} adapter(s), ${state.devices.length} known device(s)`,
		);
	} else {
		logger.info(
			`bluetooth: unavailable (${state.unavailable?.cause ?? "unknown"})`,
		);
	}
	broadcastBluetoothIfChanged();
}

/**
 * Rebuild the stack against the CURRENT persisted preference.
 *
 * A fresh instance rather than a re-`start()` on the held one, because the
 * boot-reconnect latch is per-instance and an operator who has just switched
 * Bluetooth back on wants their trusted devices reconnected — that is the one
 * moment the "once per process" rule would be wrong. Never throws: `start()`
 * resolves every failure into a typed `bt_unavailable`.
 */
export async function refreshBluetoothStack(): Promise<void> {
	const held = stack;
	stack = undefined;
	if (held !== undefined) {
		try {
			await held.stop();
		} catch (err) {
			logger.warn(`bluetooth: stack teardown failed: ${String(err)}`);
		}
	}
	await getBluetoothStack().start();
	broadcastBluetoothIfChanged();
}

/** Test isolation seam — drops the singleton, the timer and the dedupe cache. */
export function resetBluetoothRuntimeForTest(): void {
	if (debounceTimer !== undefined) {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
	}
	stack = undefined;
	lastPayload = undefined;
}
