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

import { retryWithBackoff } from "../../helpers/retry.ts";
import type { MonitorEvent, WifiState } from "../network/state-types.ts";
import {
	getModeForInterface,
	getWifiState,
	setWifiState,
} from "./state/wifi-state.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

// Bounded confirmation poll: a production backstop for the NM monitor event.
// Re-polls authoritative NM state until the hotspot connection is reported
// active, capped so a hotspot that never comes up rolls the transition back
// instead of hanging in `activating` forever.
/** Maximum number of retry attempts for hotspot activation confirmation poll. */
const HOTSPOT_CONFIRM_ATTEMPTS = 8;
/** Initial backoff delay (ms) for hotspot confirmation retry. */
const HOTSPOT_CONFIRM_BASE_MS = 500;
/** Maximum backoff delay (ms) for hotspot confirmation retry. */
const HOTSPOT_CONFIRM_MAX_MS = 2000;

// ─── cache sync ──────────────────────────────────────────────────────────────

/** Mirror a single interface into the MAC-keyed wifiState cache. */
export function syncWifiStateCache(
	macAddress: string,
	iface: WifiInterface,
): void {
	const prev = getWifiState();
	const next: WifiState = { ...prev };
	next[macAddress] = { ...iface, mode: getModeForInterface(iface) };
	setWifiState(next);
}

// ─── pending NM-confirmation registry ────────────────────────────────────────

type PendingHotspot = {
	ifname: string;
	connName: string;
	settled: boolean;
	confirm: () => void;
	giveUp: () => void;
};

/** In-flight hotspot activations awaiting NM confirmation, keyed by ifname. */
const pendingHotspots = new Map<string, PendingHotspot>();

export function settlePending(ifname: string, confirmed: boolean): void {
	const pending = pendingHotspots.get(ifname);
	if (!pending || pending.settled) return;
	pending.settled = true;
	pendingHotspots.delete(ifname);
	if (confirmed) {
		pending.confirm();
	} else {
		pending.giveUp();
	}
}

/**
 * React to a NetworkManager monitor event. A `connection-state` `activated`
 * event whose connection name matches a pending hotspot — or a `device-state`
 * `connected` event for the pending device — confirms the switch and flips the
 * interface to `mode: 'hotspot'`. This replaces the old force-timer hack: the
 * mode only changes when NM actually reports the hotspot up.
 */
export function handleWifiMonitorEvent(event: MonitorEvent): void {
	if (event.type === "connection-state" && event.state === "activated") {
		for (const [ifname, pending] of pendingHotspots) {
			if (pending.connName === event.connection) {
				settlePending(ifname, true);
				return;
			}
		}
		return;
	}

	if (event.type === "device-state" && event.state === "connected") {
		if (pendingHotspots.has(event.device)) {
			settlePending(event.device, true);
		}
	}
}

export function registerPendingConfirmation(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
): void {
	const ifname = wifiInterface.ifname;
	const connName = wifiInterface.hotspot.name ?? ifname;

	const confirm = () => {
		if (wifiInterface.hotspot.conn) {
			// Reflect the NM-confirmed active connection so isHotspot() is true.
			wifiInterface.conn = wifiInterface.hotspot.conn;
		}
		wifiInterface.hotspot.transition = undefined;
		deps.setDupIpSuppression(ifname, false);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface); // now mode: 'hotspot'
	};

	const giveUp = () => {
		// Confirmation never arrived — clear the transition (soft rollback). The
		// next NM poll will reconcile if the hotspot did in fact come up.
		wifiInterface.hotspot.transition = undefined;
		deps.setDupIpSuppression(ifname, false);
		deps.broadcastState();
		syncWifiStateCache(macAddress, wifiInterface);
	};

	const pending: PendingHotspot = {
		ifname,
		connName,
		settled: false,
		confirm,
		giveUp,
	};
	pendingHotspots.set(ifname, pending);

	// Production backstop: bounded confirmation poll racing the monitor event.
	const poll = deps.pollHotspotActive;
	if (poll) {
		retryWithBackoff(
			async () => {
				if (await poll(wifiInterface)) return true;
				throw new Error("hotspot not yet confirmed");
			},
			{
				maxAttempts: HOTSPOT_CONFIRM_ATTEMPTS,
				baseDelayMs: HOTSPOT_CONFIRM_BASE_MS,
				maxDelayMs: HOTSPOT_CONFIRM_MAX_MS,
				shouldRetry: () => !pending.settled,
			},
		)
			.then(() => settlePending(ifname, true))
			.catch(() => settlePending(ifname, false));
	}
}
