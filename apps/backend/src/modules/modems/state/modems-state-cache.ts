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
  modems-state-cache

  Thin in-memory wrapper around `ModemsState` (network/state-types.ts). Holds a
  single snapshot of the modems keyed by numeric modem ID, reconciles incoming
  snapshots against the current one, and notifies subscribers with a structured
  diff whenever something actually changed.

  Scope (T11):
  - Snapshot get/set + reconcile + change-callback registry.
  - A `triggerGsmConnectionsReset(id)` HOOK only — this module never calls the
    real `resetGsmConnections()` itself. The caller (T17) decides *when* to fire
    it (on modem add/remove and on config change) and wires the actual reset via
    `onGsmConnectionsReset`.

  Explicitly NOT in scope: the 10s mmcli polling loop (T17), SIM PIN/SMS/connect,
  and any change to the `modems` broadcast shape.
*/

import type {
	ModemsState,
	StateDiff,
} from "../../../modules/network/state-types.ts";
import type { Modem } from "../modems-state.ts";

/** Diff payload element: the modem ID plus its (next, or for removals prev) data. */
export type ModemDiffEntry = { id: number; data: Modem };

export type ModemsChangeCallback = (diff: StateDiff<ModemDiffEntry>) => void;
export type GsmConnectionsResetCallback = (id: number) => void;

let currentState: ModemsState = {};

const changeCallbacks = new Set<ModemsChangeCallback>();
const gsmResetCallbacks = new Set<GsmConnectionsResetCallback>();

/**
 * Stable signature of the volatile status fields used to detect a "changed"
 * modem: signal, connection, registration (surfaced as `roaming`), plus the
 * operator network + access-tech that ride along in the same status object.
 * Non-status fields (config, available_networks, …) are intentionally ignored —
 * config changes are signalled separately via `triggerGsmConnectionsReset`.
 */
function statusSignature(modem: Modem): string {
	const status = modem.status;
	if (!status) {
		return "";
	}
	return JSON.stringify({
		connection: status.connection,
		signal: status.signal,
		roaming: status.roaming,
		network: status.network,
		network_type: status.network_type,
	});
}

/** Current modems snapshot. */
export function getModemsState(): ModemsState {
	return currentState;
}

/**
 * Pure reconcile: classify every modem ID across two snapshots.
 *  - added:   present in `next`, absent from `prev`
 *  - removed: present in `prev`, absent from `next`
 *  - changed: present in both, status (signal/connection/registration/…) differs
 * Identical snapshots yield an empty diff.
 */
export function reconcileModems(
	next: ModemsState,
	prev: ModemsState,
): StateDiff<ModemDiffEntry> {
	const added: Array<ModemDiffEntry> = [];
	const removed: Array<ModemDiffEntry> = [];
	const changed: Array<ModemDiffEntry> = [];

	const prevIds = new Set(Object.keys(prev).map(Number));
	const nextIds = new Set(Object.keys(next).map(Number));

	for (const id of nextIds) {
		const nextModem = next[id];
		if (nextModem === undefined) {
			continue;
		}
		if (!prevIds.has(id)) {
			added.push({ id, data: nextModem });
			continue;
		}
		const prevModem = prev[id];
		if (
			prevModem !== undefined &&
			statusSignature(prevModem) !== statusSignature(nextModem)
		) {
			changed.push({ id, data: nextModem });
		}
	}

	for (const id of prevIds) {
		if (!nextIds.has(id)) {
			const prevModem = prev[id];
			if (prevModem !== undefined) {
				removed.push({ id, data: prevModem });
			}
		}
	}

	return { added, removed, changed };
}

function isEmptyDiff(diff: StateDiff<ModemDiffEntry>): boolean {
	return (
		diff.added.length === 0 &&
		diff.removed.length === 0 &&
		diff.changed.length === 0
	);
}

/**
 * Replace the snapshot. Reconciles against the previous snapshot first and,
 * only when the resulting diff is non-empty, notifies every `onModemsChange`
 * subscriber. The new snapshot becomes current regardless of diff emptiness.
 */
export function setModemsState(newState: ModemsState): void {
	const diff = reconcileModems(newState, currentState);
	currentState = newState;

	if (isEmptyDiff(diff)) {
		return;
	}
	for (const cb of changeCallbacks) {
		cb(diff);
	}
}

/**
 * Subscribe to modem snapshot changes. Returns an unsubscribe function.
 */
export function onModemsChange(cb: ModemsChangeCallback): () => void {
	changeCallbacks.add(cb);
	return () => {
		changeCallbacks.delete(cb);
	};
}

/**
 * Register a handler for the GSM-connections-reset hook. Returns an unsubscribe
 * function. The handler is invoked by `triggerGsmConnectionsReset`.
 */
export function onGsmConnectionsReset(
	cb: GsmConnectionsResetCallback,
): () => void {
	gsmResetCallbacks.add(cb);
	return () => {
		gsmResetCallbacks.delete(cb);
	};
}

/**
 * HOOK ONLY. Fires the registered GSM-connections-reset handlers for `id`.
 * This module never calls the real `resetGsmConnections()` automatically — the
 * caller (T17) invokes this on modem add/remove and on config change.
 */
export function triggerGsmConnectionsReset(id: number): void {
	for (const cb of gsmResetCallbacks) {
		cb(id);
	}
}
