/**
 * wifi-scan-generation.ts — pure confirmation rule for a WiFi scan.
 *
 * `rpc.wifi.scan` returns the moment the rescan is DISPATCHED, and nmcli emits
 * no scan-complete marker, so the frontend has to be told separately that a scan
 * finished. It used to guess, by fingerprinting the content of `available` and
 * watching for a change — which cannot answer the question. A scan that finds
 * the same access points, or finds none at all, leaves the content
 * byte-identical, so an honest empty result was indistinguishable from a scan
 * that never ran and could only expire on its TTL.
 *
 * The device now stamps a strictly-increasing `scanGeneration` per adapter on
 * every scan cycle it COMPLETES, empty results included. A consumer captures the
 * value at dispatch and confirms when it advances.
 *
 * The generation is PER ADAPTER, so a second radio finishing its own scan can
 * never confirm this one. The `scanAt` timestamp that rides beside it is
 * diagnostic only and must never be the confirmation signal — a wall clock can
 * move backwards, and a monotonic counter cannot.
 */

/**
 * Whether the device has completed a scan cycle since `baseline` was captured.
 *
 * A device that reports no generation at all has said nothing, so nothing is
 * confirmed — the caller's TTL is the honest bound there, exactly as it was
 * before the field existed. A baseline captured before the adapter had EVER
 * completed a scan is `undefined`, so the adapter's first reported generation is
 * itself the advance.
 */
export function hasScanGenerationAdvanced(
	baseline: number | undefined,
	current: number | undefined,
): boolean {
	if (current === undefined) return false;
	if (baseline === undefined) return true;
	return current > baseline;
}
