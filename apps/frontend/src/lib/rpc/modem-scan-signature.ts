/**
 * modem-scan-signature.ts — pure content hash of a modem operator-scan result.
 *
 * A manual modem network scan (`rpc.modems.scan`) returns the moment the rescan
 * is *dispatched* — the modem global lock answers immediately (and silently
 * drops a re-entrant scan), while the operator list streams back later over the
 * `modems`/`status` broadcast as `available_networks`. There is no scan-complete
 * marker on the wire, and the periodic full-state broadcast RE-SENDS the same
 * `available_networks` every tick — so PRESENCE of the field can never confirm a
 * scan. The only reliable signal that a scan produced something new is a change
 * in the set of visible operators.
 *
 * This signature folds the available-operator set into one stable string so a
 * baseline captured at dispatch can be compared against later broadcasts. The
 * record KEY is the operator code (MCC+MNC), so a sorted key set IS the operator
 * set; `name` + `availability` are folded in so an availability flip also moves
 * the hash. Sorted by code so broadcast order can never perturb it. An empty set
 * hashes to the empty string.
 */

/** The stable subset of an available operator used to fingerprint a scan result. */
export interface ModemScanSignatureNetwork {
	name: string;
	availability?: string;
}

/**
 * A stable content hash of the available-operator set. Sorted by operator code
 * so the broadcast order can never perturb it. An absent/empty set hashes to the
 * empty string, so a baseline taken before any operators are known differs from
 * any later broadcast that surfaces one.
 */
export function modemScanSignature(
	networks: Readonly<Record<string, ModemScanSignatureNetwork>> | undefined,
): string {
	return Object.entries(networks ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([code, net]) => `${code}|${net.name}|${net.availability ?? ""}`)
		.join(",");
}
