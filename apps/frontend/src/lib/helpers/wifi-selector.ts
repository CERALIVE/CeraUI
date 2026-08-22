/**
 * wifi-selector.ts — pure display helpers shared by the WifiSelectorDialog
 * sub-components (parent dialog + WifiNetworkList).
 *
 * Extracted verbatim from the former monolithic WifiSelectorDialog.svelte so the
 * connect-handler logic (parent) and the list rendering (child) reference one
 * source of truth — no behaviour change.
 */
import { wifiJoinRefusal } from "@ceraui/rpc";
import type {
	AvailableWifiNetwork,
	WifiAdapterCapabilities,
} from "@ceraui/rpc/schemas";

import { getSignalCategory } from "$lib/helpers/signal";

/** A secured network advertises a WPA variant. */
export function isSecured(network: AvailableWifiNetwork): boolean {
	return network.security.includes("WPA");
}

export type WifiRowBlock = {
	readonly titleKey: string;
	readonly bodyKey: string;
};

/**
 * Maps `@ceraui/rpc`'s `wifiJoinRefusal` — the SAME verdict the device's join
 * path uses to decide whether to pin `key-mgmt sae` — onto operator copy. It
 * decides nothing itself, so an offering the device would refuse cannot exist.
 *
 * It therefore inherits that rule's FAIL-OPEN posture: only a positive
 * `wpa3Sae: 'unsupported'` withholds a row. `unknown` is the shipped fleet's
 * answer under NM 1.42.4, so refusing on it would take WPA3 away from every
 * board — the attempt is offered and the device's own typed auth failure is
 * what tells the truth on refusal.
 */
export function wifiRowBlock(
	network: AvailableWifiNetwork,
	capabilities: WifiAdapterCapabilities | undefined,
): WifiRowBlock | undefined {
	const refusal = wifiJoinRefusal(network.security, capabilities?.wpa3Sae);
	if (refusal === undefined) return undefined;
	return {
		titleKey: "wifiSelector.blocked.wpa3Title",
		bodyKey: "wifiSelector.blocked.wpa3Body",
	};
}

/** Human band label for a channel frequency. */
export function frequencyBand(freq: number): string {
	if (freq >= 5000) return "5 GHz";
	if (freq >= 2400) return "2.4 GHz";
	return `${freq} MHz`;
}

/** Text colour token for a signal reading — matches NetworkView / SignalIndicator tiers. */
export function signalTextClass(signal: number): string {
	switch (getSignalCategory(signal)) {
		case "excellent":
			return "text-signal-excellent";
		case "good":
			return "text-signal-good";
		case "fair":
			return "text-signal-fair";
		default:
			return "text-signal-weak";
	}
}
