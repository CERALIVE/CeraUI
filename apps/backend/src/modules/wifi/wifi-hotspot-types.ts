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

import type { WifiChannel } from "./wifi-channels.ts";
import type { BaseWifiInterface, WifiInterface } from "./wifi-interfaces.ts";

export type WifiHotspotMessage = {
	hotspot: {
		start?: { device: number };
		stop?: { device: number };
		config?: {
			device: number;
			name: unknown;
			channel: unknown;
			password?: unknown;
		};
	};
};

export type WifiHotspot = {
	conn?: string;
	name?: string;
	password?: string;
	channel?: WifiChannel;
	availableChannels: WifiChannel[];
	warnings: Record<string, boolean>;
	/**
	 * Set while a station↔hotspot switch is in flight. The interface is NOT yet
	 * reported as `mode: 'hotspot'` during this window — that flip only happens
	 * once NetworkManager confirms the hotspot connection is activated (see
	 * {@link handleWifiMonitorEvent} / the bounded confirmation poll).
	 */
	transition?: "activating" | "deactivating";
};

export type WifiInterfaceWithHotspot = BaseWifiInterface & {
	hotspot: WifiHotspot;
};

/** nmcli activation timeout (seconds) for hotspot connect operations. */
export const HOTSPOT_UP_TO = 10;

/** Result of a hotspot start request. */
export type HotspotStartResult =
	| { success: true }
	| {
			success: false;
			error: "DEVICE_BUSY" | "no-device" | "unsupported" | "activation-failed";
	  };

/**
 * Injectable side-effect surface for the hotspot start flow. Production wires
 * the real NetworkManager helpers; tests pass deterministic fakes (and omit
 * `pollHotspotActive` so confirmation comes purely from a fed monitor event).
 */
export type HotspotActivationDeps = {
	nmConnect: (uuid: string, timeout?: number) => Promise<unknown>;
	nmConnSetFields: (
		uuid: string,
		fields: Record<string, string>,
	) => Promise<unknown>;
	nmHotspot: (
		device: string,
		ssid: string,
		password: string,
		timeout?: number,
	) => Promise<string | null | undefined>;
	wifiUpdateSavedConns: () => Promise<void>;
	broadcastState: () => void;
	setDupIpSuppression: (ifname: string, suppressed: boolean) => void;
	/**
	 * Optional bounded confirmation poll. When provided, it is retried with
	 * backoff until it returns `true` (confirming the hotspot is up) or attempts
	 * are exhausted (rolling the transition back). When omitted, confirmation can
	 * only arrive via {@link handleWifiMonitorEvent}.
	 */
	pollHotspotActive?: (iface: WifiInterfaceWithHotspot) => Promise<boolean>;
};

// ─── mode predicates ─────────────────────────────────────────────────────────

export function canHotspot(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	return wifiInterface && "hotspot" in wifiInterface;
}

/**
 * True only when NetworkManager has the interface's active connection set to
 * its hotspot connection. There is no force-timer override anymore — a hotspot
 * that is still `activating` reports `false` here (and `transition` carries the
 * in-flight signal for the UI).
 *
 * `activeConn` is accepted alongside `conn` because `conn` is additionally gated
 * on the radio holding an IP; without it a broadcasting hotspot flickered back
 * to station mode whenever the ifconfig poll lagged.
 */
export function isHotspot(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	if (!canHotspot(wifiInterface)) return false;
	const hotspotConn = wifiInterface.hotspot.conn;
	if (!hotspotConn) return false;
	return (
		wifiInterface.conn === hotspotConn ||
		wifiInterface.activeConn === hotspotConn
	);
}

/**
 * True when the radio is operating as an access point — either confirmed via its
 * own hotspot profile ({@link isHotspot}), or because NetworkManager reports the
 * active connection's 802.11 mode as `ap` before that profile has been adopted.
 *
 * This is the classification the operator UI must use. `isHotspot` alone
 * depended on hotspot-profile discovery having completed, so an AP-mode radio
 * could still be presented with client "Connect" / "In Bond" controls.
 */
export function isApMode(
	wifiInterface: WifiInterface,
): wifiInterface is WifiInterfaceWithHotspot {
	return (
		isHotspot(wifiInterface) ||
		(canHotspot(wifiInterface) && wifiInterface.activeMode === "ap")
	);
}
