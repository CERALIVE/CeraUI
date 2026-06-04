/*
    CeraUI - web UI for the CERALIVE project
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
 * Pure netif state cache + reconcile.
 *
 * This module owns the in-memory `NetifState` snapshot and a single change
 * callback. It deliberately does NOT poll, spawn `ifconfig`, or build/broadcast
 * the `netif` websocket message — that polling loop migration is T14. Here we
 * only provide:
 *   - a plain cached state + explicit setter
 *   - a single onNetifChange callback registry
 *   - a pure reconcileNetif(next, prev) diff function
 */
import type { NetifState, StateDiff } from "../state-types.ts";

/** One diffed entry: the interface name plus its (next) data. */
export type NetifDiffEntry = {
	name: string;
	data: NetifState[string];
};

let netifState: NetifState = {};

let onChangeCb: ((diff: StateDiff<NetifDiffEntry>) => void) | undefined;

/** Read the current cached netif state. */
export function getNetifState(): NetifState {
	return netifState;
}

/**
 * Replace the cached netif state with `newState`, reconcile against the
 * previous snapshot, and fire the registered callback when anything changed.
 * The reconcile itself is pure; this setter is the only place callbacks fire.
 */
export function setNetifState(newState: NetifState): void {
	const prev = netifState;
	netifState = newState;

	const diff = reconcileNetif(newState, prev);
	if (
		diff.added.length > 0 ||
		diff.removed.length > 0 ||
		diff.changed.length > 0
	) {
		onChangeCb?.(diff);
	}
}

/**
 * Register the single change callback (replaces any prior one). Returns an
 * unsubscribe function that clears the callback if it is still the active one.
 */
export function onNetifChange(
	cb: (diff: StateDiff<NetifDiffEntry>) => void,
): () => void {
	onChangeCb = cb;
	return () => {
		if (onChangeCb === cb) onChangeCb = undefined;
	};
}

function netifEntryEquals(
	a: NetifState[string],
	b: NetifState[string],
): boolean {
	return (
		a.ip === b.ip &&
		a.mac === b.mac &&
		a.up === b.up &&
		a.tp === b.tp &&
		a.txb === b.txb &&
		a.error === b.error
	);
}

/**
 * Pure diff between two netif snapshots.
 *   - added:   interfaces present in `next` but not in `prev`
 *   - removed: interfaces present in `prev` but not in `next`
 *   - changed: interfaces present in both whose data differs in any field
 * Identical snapshots yield an empty diff. Does NOT fire callbacks.
 */
export function reconcileNetif(
	next: NetifState,
	prev: NetifState,
): StateDiff<NetifDiffEntry> {
	const added: NetifDiffEntry[] = [];
	const removed: NetifDiffEntry[] = [];
	const changed: NetifDiffEntry[] = [];

	for (const name in next) {
		const nextEntry = next[name];
		if (!nextEntry) continue;

		const prevEntry = prev[name];
		if (!prevEntry) {
			added.push({ name, data: nextEntry });
		} else if (!netifEntryEquals(nextEntry, prevEntry)) {
			changed.push({ name, data: nextEntry });
		}
	}

	for (const name in prev) {
		const prevEntry = prev[name];
		if (!prevEntry) continue;

		if (!next[name]) {
			removed.push({ name, data: prevEntry });
		}
	}

	return { added, removed, changed };
}
