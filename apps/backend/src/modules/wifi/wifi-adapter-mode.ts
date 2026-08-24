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
  THE per-adapter operating mode: what the radio IS, what the operator ASKED
  for, and what may be offered.

  It is deliberately a LEAF — persistence, one pure derivation and one pure
  offer builder, and nothing that touches NetworkManager. The transition itself
  lives in `wifi-adapter-mode-transition.ts`, which imports the hotspot
  transactions; keeping the two apart is what lets `wifi-hotspot-activation.ts`
  read the persisted preference (to decide exclusive-vs-concurrent) without an
  import cycle back through its own caller.

  WHY THE THREE-WAY MODE IS NOT A THIRD `mode` VALUE. `hybrid` is a station that
  additionally hosts an AP on the virtual `clap-<parent>` netdev, so the physical
  radio really is still a station and `mode: "station"` is the true report. That
  is a pinned device assertion and every rule keyed on "the radio is a station"
  depends on it, so the selector maps ONTO the existing model rather than
  widening it.
*/

import type {
	WifiAdapterMode,
	WifiAdapterModeEntry,
	WifiAdapterModeOption,
	WifiAdapterModeStatus,
	WifiAdapterModeUnavailableReason,
} from "@ceraui/rpc/schemas";

import { getConfig, saveConfig } from "../config.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import {
	canHotspot,
	isApMode,
	isConcurrentHotspot,
} from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

/** Display order, and the order the TOTAL offered set is emitted in. */
export const WIFI_ADAPTER_MODES = [
	"station",
	"hotspot",
	"hybrid",
] as const satisfies readonly WifiAdapterMode[];

/**
 * The mode the radio is in RIGHT NOW, derived from the same predicates the wire
 * `mode` field and the state cache use — so an observed mode and the broadcast
 * one can never disagree about the same radio.
 *
 * `isConcurrentHotspot` is tested first: a concurrent AP leaves the physical
 * interface reporting `station`, so an `isApMode`-first order would report every
 * hybrid radio as a plain station.
 */
export function observedWifiAdapterMode(
	wifiInterface: WifiInterface,
): WifiAdapterMode {
	if (isConcurrentHotspot(wifiInterface)) return "hybrid";
	if (isApMode(wifiInterface)) return "hotspot";
	return "station";
}

export interface WifiAdapterModeCapability {
	/** Can this radio host an access point at all? */
	readonly supportsHotspot: boolean;
	/**
	 * The wiphy's own AP+STA verdict. `undefined` means NOT PROVEN — no `iw`, an
	 * unresolvable wiphy, or a dump that failed its parser — which is a different
	 * fact from a wiphy that answered and forbids the combination.
	 */
	readonly staApComboSupported: boolean | undefined;
}

/**
 * The TOTAL offered set for one radio: all three modes, always, each carrying an
 * explicit `available` and — when it is not — the reason.
 *
 * Pure, so the whole capability gate is testable without a radio. Nothing is
 * ever omitted: an operator has to be able to see that `hybrid` exists and why
 * this radio cannot have it, which is the difference between a device that
 * refuses honestly and one that appears not to have the feature.
 */
export function wifiAdapterModeOptions(
	capability: WifiAdapterModeCapability,
): WifiAdapterModeOption[] {
	const apReason = (): WifiAdapterModeUnavailableReason | undefined =>
		capability.supportsHotspot ? undefined : "unsupported";

	const hybridReason = (): WifiAdapterModeUnavailableReason | undefined => {
		if (!capability.supportsHotspot) return "unsupported";
		if (capability.staApComboSupported === undefined)
			return "capability-unknown";
		return capability.staApComboSupported ? undefined : "capability-absent";
	};

	return WIFI_ADAPTER_MODES.map((mode) => {
		const reason =
			mode === "station"
				? undefined
				: mode === "hotspot"
					? apReason()
					: hybridReason();
		return {
			mode,
			available: reason === undefined,
			...(reason !== undefined ? { reason } : {}),
		};
	});
}

/** Read this adapter's capability inputs off the live capability cache. */
export function wifiAdapterModeCapability(
	wifiInterface: WifiInterface,
	readCapabilities: (
		ifname: string,
	) => { staApCombo: { supported: boolean } } | undefined = (ifname) =>
		getWifiCapabilitiesForInterface(ifname),
): WifiAdapterModeCapability {
	return {
		supportsHotspot: canHotspot(wifiInterface),
		staApComboSupported: readCapabilities(wifiInterface.ifname)?.staApCombo
			.supported,
	};
}

export function isWifiAdapterModeAvailable(
	mode: WifiAdapterMode,
	options: readonly WifiAdapterModeOption[],
): boolean {
	return options.some((option) => option.mode === mode && option.available);
}

// ─── persistence (permanent-MAC keyed) ───────────────────────────────────────

/**
 * The operator's stated mode for this adapter, or `undefined` when they have
 * never chosen. Absence is deliberately NOT `station`: the boot reconciler acts
 * on a stated preference only, so an untouched device keeps its behaviour.
 */
export function getPersistedWifiAdapterMode(
	macAddress: string,
): WifiAdapterMode | undefined {
	return getConfig().wifi_modes?.[macAddress];
}

/** Every stated preference, keyed by permanent MAC. */
export function getPersistedWifiAdapterModes(): Readonly<
	Record<string, WifiAdapterMode>
> {
	return getConfig().wifi_modes ?? {};
}

/**
 * Record the operator's choice. Persisted BEFORE the radio is touched, on
 * `wifi-country.ts`'s terms: the persisted value is what the boot reconciler
 * re-applies, so a device that loses power mid-transition comes back trying for
 * the operator's mode rather than silently keeping the one it was leaving.
 */
export function persistWifiAdapterMode(
	macAddress: string,
	mode: WifiAdapterMode,
): void {
	const config = getConfig();
	config.wifi_modes = { ...(config.wifi_modes ?? {}), [macAddress]: mode };
	saveConfig();
}

/**
 * Restore a previous preference after a failed transition.
 *
 * `undefined` REMOVES the key rather than writing a value: an adapter that had
 * never been given a preference must not acquire one because a transition was
 * attempted and failed.
 */
export function restoreWifiAdapterMode(
	macAddress: string,
	previous: WifiAdapterMode | undefined,
): void {
	const config = getConfig();
	const next = { ...(config.wifi_modes ?? {}) };
	if (previous === undefined) {
		delete next[macAddress];
	} else {
		next[macAddress] = previous;
	}
	config.wifi_modes = next;
	saveConfig();
}

// ─── wire projection ─────────────────────────────────────────────────────────

export function buildWifiAdapterModeEntry(
	macAddress: string,
	wifiInterface: WifiInterface,
	readCapabilities?: (
		ifname: string,
	) => { staApCombo: { supported: boolean } } | undefined,
): WifiAdapterModeEntry {
	const desired = getPersistedWifiAdapterMode(macAddress);
	return {
		ifname: wifiInterface.ifname,
		mode: observedWifiAdapterMode(wifiInterface),
		...(desired !== undefined ? { desired } : {}),
		options: wifiAdapterModeOptions(
			wifiAdapterModeCapability(wifiInterface, readCapabilities),
		),
	};
}

export function buildWifiAdapterModeStatus(
	interfaces: Readonly<Record<string, WifiInterface>>,
	readCapabilities?: (
		ifname: string,
	) => { staApCombo: { supported: boolean } } | undefined,
): WifiAdapterModeStatus {
	const status: WifiAdapterModeStatus = {};
	for (const macAddress in interfaces) {
		const wifiInterface = interfaces[macAddress];
		if (!wifiInterface) continue;
		status[String(wifiInterface.id)] = buildWifiAdapterModeEntry(
			macAddress,
			wifiInterface,
			readCapabilities,
		);
	}
	return status;
}
