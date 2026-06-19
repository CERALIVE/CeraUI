/**
 * Remote Control Plane v2.0 — device-side command idempotency (spec §6.1).
 *
 * The hub may RETRY a command (bounded, exponential backoff) until the device's
 * `delivery.ack` echoes the `cid`. A retry replays the SAME `cid`, so the device
 * must execute a command at most once: it re-acknowledges a replay but never
 * re-runs it. This is the seen-`cid` set that backs that guarantee.
 *
 * The set is bounded by a TTL (the window only needs to exceed the hub's total
 * retry budget — seconds) and by a hard cap so a long-lived device never grows it
 * without bound. The clock is injectable so tests drive expiry deterministically.
 *
 * `self_fencing.confirm` deliberately reuses the original command's `cid` and is
 * therefore NEVER routed through this store — it resolves a pending op rather
 * than starting a new one (the command router handles it before the dedup gate).
 */

/** Default seen-`cid` TTL: comfortably longer than the hub's bounded retry budget. */
export const DEFAULT_SEEN_CID_TTL_MS = 5 * 60_000;

/** Hard cap on retained cids, so a long-lived device never grows the set unboundedly. */
export const DEFAULT_SEEN_CID_MAX = 4_096;

export interface SeenCidStoreDeps {
	now: () => number;
	ttlMs: number;
	max: number;
}

export interface SeenCidStore {
	/**
	 * If `cid` was already seen within the TTL, return `true` (a duplicate — do
	 * NOT re-execute). Otherwise record it as seen now and return `false`.
	 */
	checkAndRemember(cid: string): boolean;
	/** Number of currently-retained cids (post lazy-eviction is not forced here). */
	size(): number;
	/** Drop all retained cids (test seam / reconnect reset). */
	clear(): void;
}

export function createSeenCidStore(
	overrides: Partial<SeenCidStoreDeps> = {},
): SeenCidStore {
	const now = overrides.now ?? Date.now;
	const ttlMs = overrides.ttlMs ?? DEFAULT_SEEN_CID_TTL_MS;
	const max = overrides.max ?? DEFAULT_SEEN_CID_MAX;

	// cid → expiry epoch-ms. Insertion order is preserved by Map, so the oldest
	// entry is always the first key — used for the size-cap eviction below.
	const seen = new Map<string, number>();

	function evictExpired(at: number): void {
		for (const [cid, expiry] of seen) {
			if (expiry > at) break; // Map keeps insertion order; later entries are newer.
			seen.delete(cid);
		}
	}

	return {
		checkAndRemember(cid): boolean {
			const at = now();
			const expiry = seen.get(cid);
			if (expiry !== undefined && expiry > at) {
				return true;
			}
			// A stale (expired) entry for this cid is overwritten with a fresh window.
			seen.delete(cid);
			evictExpired(at);
			seen.set(cid, at + ttlMs);
			while (seen.size > max) {
				const oldest = seen.keys().next().value;
				if (oldest === undefined) break;
				seen.delete(oldest);
			}
			return false;
		},
		size(): number {
			return seen.size;
		},
		clear(): void {
			seen.clear();
		},
	};
}

/** Process-wide seen-cid store the command router uses by default. */
let sharedStore: SeenCidStore | undefined;

export function getSharedSeenCidStore(): SeenCidStore {
	if (sharedStore === undefined) {
		sharedStore = createSeenCidStore();
	}
	return sharedStore;
}

/** Test seam: reset the shared store so a suite starts from a clean set. */
export function resetSharedSeenCidStore(): void {
	sharedStore = undefined;
}
