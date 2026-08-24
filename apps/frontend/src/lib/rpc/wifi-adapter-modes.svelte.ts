/**
 * wifi-adapter-modes — the per-adapter station/hotspot/hybrid offering.
 *
 * This is a PULL (`rpc.wifi.getAdapterModes`), not a field on the `wifi`
 * broadcast, so it needs a slot of its own. It is deliberately NOT owned by
 * `subscriptions.svelte.ts`: that module is the sole `rpcClient.onMessage`
 * consumer, and nothing here reads the socket.
 *
 * The map is a CACHE of the device's own answer, never a local derivation. A
 * refresh is triggered on mount and after a terminal mode-change frame, because
 * a successful transition changes both `mode` and (for hybrid) which options are
 * still on offer.
 *
 * `undefined` before the first answer is load-bearing: it is "we have not asked
 * yet", which a consumer must render as the adapter's own legacy truth rather
 * than as an empty offering.
 */

import type {
	WifiAdapterModeEntry,
	WifiAdapterModeStatus,
} from "@ceraui/rpc/schemas";

import { rpc } from "./client";

let adapterModes = $state<WifiAdapterModeStatus | undefined>(undefined);
let inFlight: Promise<void> | undefined;

export function getWifiAdapterModes(): WifiAdapterModeStatus | undefined {
	return adapterModes;
}

export function getWifiAdapterModeEntry(
	device: string,
): WifiAdapterModeEntry | undefined {
	return adapterModes?.[device];
}

/**
 * Self-serialising: a second call while one is in flight awaits the same pull
 * rather than racing a duplicate answer onto the slot.
 */
export function refreshWifiAdapterModes(): Promise<void> {
	if (inFlight) return inFlight;
	// The dispatch itself can throw SYNCHRONOUSLY (a transport that is not up, a
	// double without the method). Callers run this from an `$effect`, where an
	// escaping throw tears down the component rather than degrading the offering.
	inFlight = Promise.resolve()
		.then(() => rpc.wifi.getAdapterModes())
		.then((modes) => {
			adapterModes = modes;
		})
		.catch(() => {
			// A failed read says nothing about the adapter, so the previous answer
			// stands. Replacing it with `{}` would report every mode as unoffered.
		})
		.finally(() => {
			inFlight = undefined;
		});
	return inFlight;
}

/** Test/reset seam — also called from `resetState()` on a session teardown. */
export function resetWifiAdapterModes(): void {
	adapterModes = undefined;
	inFlight = undefined;
}

/** Test seam: seed the slot without a socket. */
export function setWifiAdapterModesForTest(
	modes: WifiAdapterModeStatus | undefined,
): void {
	adapterModes = modes;
}
