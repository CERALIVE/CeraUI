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
  WiFi state cache + reconciler.

  A MAC-keyed snapshot of WiFi interfaces with a derived `mode`
  ('station' | 'hotspot'). `setWifiState` swaps the cache and fires the
  registered `onWifiChange` callback only when `reconcileWifi` detects a real
  change. `reconcileWifi` is pure and never touches the cache.

  This module deliberately does NOT poll, scan, or connect — that logic stays
  in wifi-connections.ts / wifi.ts (T15/T16). It also leaves the `wifi`
  broadcast shape (wifiBuildMsg) untouched.
*/

import type { StateDiff, WifiState } from "../../network/state-types.ts";
import { isHotspot } from "../wifi-hotspot-types.ts";
import type { WifiInterface } from "../wifi-interfaces.ts";

type WifiStateEntry = WifiState[string];

/** A single MAC-keyed reconcile result entry. */
export type WifiDiffEntry = { mac: string; data: WifiStateEntry };

/** Callback invoked when `setWifiState` observes a non-empty diff. */
export type WifiChangeCallback = (diff: StateDiff<WifiDiffEntry>) => void;

// ─── cache + callback registry ───────────────────────────────────────────────

let wifiState: WifiState = {};
let onWifiChangeCb: WifiChangeCallback | null = null;

/** Returns the current MAC-keyed WiFi state snapshot. */
export function getWifiState(): Readonly<WifiState> {
	return wifiState;
}

/**
 * Replaces the cached WiFi state. Reconciles against the previous snapshot and,
 * if anything meaningful changed, fires the registered `onWifiChange` callback
 * with the diff. Identical content produces no callback.
 */
export function setWifiState(newState: WifiState): void {
	const prev = wifiState;
	const diff = reconcileWifi(newState, prev);
	wifiState = newState;

	if (
		onWifiChangeCb &&
		(diff.added.length > 0 ||
			diff.removed.length > 0 ||
			diff.changed.length > 0)
	) {
		onWifiChangeCb(diff);
	}
}

/** Registers the single WiFi-change callback (replaces any previous one). */
export function onWifiChange(cb: WifiChangeCallback): void {
	onWifiChangeCb = cb;
}

// ─── mode derivation ─────────────────────────────────────────────────────────

/**
 * Derives the operating mode of a WiFi interface using the existing
 * `isHotspot()` logic (a `WifiInterfaceWithHotspot` actively in hotspot mode).
 */
export function getModeForInterface(
	iface: WifiInterface,
): "station" | "hotspot" {
	return isHotspot(iface) ? "hotspot" : "station";
}

// ─── reconciliation ──────────────────────────────────────────────────────────

/**
 * The SSID the interface is currently associated with: the hotspot name in
 * hotspot mode, otherwise the active scan entry (if any).
 */
function activeSsid(entry: WifiStateEntry): string | undefined {
	if (entry.mode === "hotspot" && "hotspot" in entry) {
		return entry.hotspot.name;
	}
	for (const network of entry.available.values()) {
		if (network.active) return network.ssid;
	}
	return undefined;
}

/** The set of SSIDs currently visible to the interface. */
function availableSsids(entry: WifiStateEntry): Set<string> {
	return new Set(entry.available.keys());
}

/** True when the set of available SSIDs differs (ignores signal fluctuations). */
function availableNetworksDiffer(
	a: WifiStateEntry,
	b: WifiStateEntry,
): boolean {
	const aSet = availableSsids(a);
	const bSet = availableSsids(b);
	if (aSet.size !== bSet.size) return true;
	for (const ssid of aSet) {
		if (!bSet.has(ssid)) return true;
	}
	return false;
}

/**
 * True when two snapshots of the same interface differ in a way that matters:
 * mode, active connection, associated SSID, or the set of available networks.
 */
function entryChanged(next: WifiStateEntry, prev: WifiStateEntry): boolean {
	if (next.mode !== prev.mode) return true;
	if (next.conn !== prev.conn) return true;
	if (activeSsid(next) !== activeSsid(prev)) return true;
	if (availableNetworksDiffer(next, prev)) return true;
	return false;
}

/**
 * Pure diff between two MAC-keyed WiFi snapshots.
 *   - `added`:   MACs in `next` but not `prev`
 *   - `removed`: MACs in `prev` but not `next`
 *   - `changed`: MACs in both whose mode/connection/ssid/available-networks differ
 * Identical states yield an empty diff.
 */
export function reconcileWifi(
	next: WifiState,
	prev: WifiState,
): StateDiff<WifiDiffEntry> {
	const added: WifiDiffEntry[] = [];
	const removed: WifiDiffEntry[] = [];
	const changed: WifiDiffEntry[] = [];

	for (const mac in next) {
		const nextEntry = next[mac];
		if (!nextEntry) continue;
		const prevEntry = prev[mac];
		if (!prevEntry) {
			added.push({ mac, data: nextEntry });
		} else if (entryChanged(nextEntry, prevEntry)) {
			changed.push({ mac, data: nextEntry });
		}
	}

	for (const mac in prev) {
		const prevEntry = prev[mac];
		if (!prevEntry) continue;
		if (!(mac in next)) {
			removed.push({ mac, data: prevEntry });
		}
	}

	return { added, removed, changed };
}
