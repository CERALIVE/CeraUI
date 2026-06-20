/**
 * wifi-scan-signature.ts — pure content hash of a WiFi scan result.
 *
 * A manual WiFi scan (`rpc.wifi.scan`) returns the moment the rescan is
 * *dispatched* — long before NetworkManager finishes scanning and the
 * `status.wifi.available` list refreshes. There is no scan-complete marker on
 * the wire, so the only signal that a scan actually produced something new is a
 * change in the set of visible access points.
 *
 * This signature folds the *stable* fields of the available set into one string
 * so a baseline captured at dispatch can be compared against later broadcasts.
 * `signal` is EXCLUDED on purpose: it fluctuates on every periodic re-broadcast,
 * so including it would false-confirm a scan that found nothing new. Only a
 * genuine add/remove of an AP (or a security/band change) moves the signature.
 */

/** The stable subset of an available network used to fingerprint a scan result. */
export interface WifiScanSignatureNetwork {
	ssid: string;
	security: string;
	freq: number;
}

/**
 * A stable content hash of the available-network set. Sorted by `ssid` so the
 * broadcast order can never perturb it; `signal` is deliberately omitted (it
 * ticks every refresh and would false-confirm). An empty set hashes to the empty
 * string.
 */
export function wifiScanSignature(
	networks: readonly WifiScanSignatureNetwork[],
): string {
	return [...networks]
		.sort((a, b) => a.ssid.localeCompare(b.ssid))
		.map((n) => `${n.ssid}|${n.security}|${n.freq}`)
		.join(",");
}
