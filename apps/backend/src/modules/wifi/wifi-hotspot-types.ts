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

import type {
	HotspotCredentials,
	HotspotCredentialsStore,
} from "./hotspot-credentials.ts";
import type { DerivedApChannel, WifiChannel } from "./wifi-channels.ts";
import {
	DEFAULT_HOTSPOT_SECURITY,
	type HotspotSecurityId,
	hotspotSecurityFields,
} from "./wifi-hotspot-security.ts";
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
			security?: unknown;
		};
	};
};

export type WifiHotspot = {
	conn?: string;
	name?: string;
	password?: string;
	channel?: WifiChannel;
	/**
	 * The channels this adapter may be configured with: its band-wide auto
	 * entries plus every channel derived from the LIVE regulatory domain. This
	 * is the authoritative acceptance set — `wifiHotspotConfig` rejects anything
	 * absent from it.
	 */
	availableChannels: WifiChannel[];
	/** Last `iw phy` derivation, kept for the channel→NetworkManager band mapping. */
	derivedChannels?: DerivedApChannel[];
	/**
	 * The configured security mode. Absent means the adapter has never been given
	 * one, which resolves to {@link DEFAULT_HOTSPOT_SECURITY} — the behaviour
	 * every hotspot had before the mode was selectable.
	 *
	 * There is no cached `availableSecurity` beside it: the offered set is
	 * derived from the live capability read on every use (see
	 * `wifi-hotspot-security.ts`), so it cannot go stale against the radio.
	 */
	security?: HotspotSecurityId;
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

/**
 * nmcli activation timeout (seconds) for hotspot connect operations.
 *
 * Must exceed NetworkManager's OWN verdict on an AP activation, which it
 * delivers at a fixed 25 s (`Activation: (wifi) Hotspot network creation took
 * too long, failing activation`). At the previous 10 s, nmcli reported a
 * timeout while NetworkManager was still working, so a slow-but-successful
 * hotspot was recorded as a failure — and since autoconnect is only armed on a
 * confirmed success, that profile was left unable to recover on its own. A
 * successful AP start takes well under a second, so this costs nothing on the
 * happy path.
 */
export const HOTSPOT_UP_TO = 30;

/** An existing NetworkManager AP profile resolved back to its adapter. */
export type ExistingHotspotConn = {
	uuid: string;
	ssid: string;
	password: string;
	channel: WifiChannel;
};

/**
 * Settings that bind an AP profile to THIS adapter and make it joinable. Applied
 * BEFORE activation, because NetworkManager matches `802-11-wireless.mac-address`
 * against the adapter's permanent address and refuses a profile bound to
 * anything else — so a profile written while the address was randomized has to
 * be repaired first or the activation simply fails.
 *
 * `connection.interface-name` is deliberately cleared: the MAC binding is the
 * stable one, and NetworkManager rejects a profile whose `interface-name` names
 * a device the MAC binding excludes. The empty string (rather than an omitted
 * arg) is required by the Bun runtime's CLI argument handling.
 *
 * The PMF value follows the SECURITY selection rather than being fixed: this
 * runs on every start, so a hardcoded `disable` would re-pin a WPA3-SAE profile
 * to a value SAE forbids and the activation would fail every time. An unset
 * selection resolves to WPA2, which reproduces the previous field set exactly.
 */
export function hotspotBindingFields(
	permanentMacAddress: string,
	security: HotspotSecurityId = DEFAULT_HOTSPOT_SECURITY,
): Record<string, string> {
	return {
		"connection.interface-name": "",
		"802-11-wireless.mac-address": permanentMacAddress,
		...hotspotSecurityFields(security),
	};
}

/**
 * Applied only AFTER a confirmed activation. Arming autoconnect beforehand lets
 * NetworkManager race its own auto-activation against the explicit `con up`, and
 * would leave a profile that never came up trying again at every boot.
 */
export const HOTSPOT_AUTOCONNECT_FIELDS: Record<string, string> = {
	"connection.autoconnect": "yes",
	"connection.autoconnect-priority": "999",
};

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
	/** Durable per-adapter hotspot identity, keyed by permanent MAC address. */
	credentials: HotspotCredentialsStore;
	/**
	 * Deterministic lookup of the NetworkManager AP profile that belongs to this
	 * adapter. Runs BEFORE any credential generation so a restart reuses the
	 * profile it already created instead of minting a new one.
	 */
	findHotspotConn: (
		macAddress: string,
		stored: HotspotCredentials | undefined,
	) => Promise<ExistingHotspotConn | undefined>;
	/** Best-effort removal of superseded CeraUI-generated AP profiles. */
	pruneHotspotConns: (macAddress: string, keepUuid: string) => Promise<void>;
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
