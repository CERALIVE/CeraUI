/**
 * wifi-selector.ts — pure display helpers shared by the WifiSelectorDialog
 * sub-components (parent dialog + WifiNetworkList).
 *
 * Extracted verbatim from the former monolithic WifiSelectorDialog.svelte so the
 * connect-handler logic (parent) and the list rendering (child) reference one
 * source of truth — no behaviour change.
 */
import type { AvailableWifiNetwork } from '@ceraui/rpc/schemas';

import { getSignalCategory } from '$lib/helpers/signal';

/** A secured network advertises a WPA variant. */
export function isSecured(network: AvailableWifiNetwork): boolean {
	return network.security.includes('WPA');
}

/** Human band label for a channel frequency. */
export function frequencyBand(freq: number): string {
	if (freq >= 5000) return '5 GHz';
	if (freq >= 2400) return '2.4 GHz';
	return `${freq} MHz`;
}

/** Text colour token for a signal reading — matches NetworkView / SignalIndicator tiers. */
export function signalTextClass(signal: number): string {
	switch (getSignalCategory(signal)) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		default:
			return 'text-signal-weak';
	}
}
