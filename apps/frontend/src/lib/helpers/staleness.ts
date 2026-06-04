/**
 * Shared staleness render-state helper — Task 13
 *
 * A single, canonical mapping from a live value plus its staleness flag onto a
 * three-state render mode. Every live-value component (HUD, network links,
 * sensors, …) routes through this so they all degrade *consistently* under the
 * "Live-Data Discipline" rule (`.impeccable.md` §4): aged data is de-emphasised
 * (`'stale'`) and absent data reads as `'nodata'` — never a misleading
 * fresh-looking value.
 *
 * Staleness itself is decided upstream against the global
 * {@link STALE_THRESHOLD_MS} (see `lib/stores/hud.svelte.ts`); this helper never
 * introduces its own threshold. Components pass the already-computed `isStale`
 * flag and the last-known `value`.
 */

/** The three render modes a live value can be in. */
export type StalenessState = 'fresh' | 'stale' | 'nodata';

/**
 * Map a live value + its staleness flag onto a {@link StalenessState}.
 *
 * Precedence (deliberate):
 *  1. `value == null` → `'nodata'` — absence wins over everything. A value we
 *     never received is "no data", regardless of any timestamp.
 *  2. `isStale === true` → `'stale'` — we have a last-known value but it has
 *     aged past the global threshold; de-emphasise it.
 *  3. otherwise → `'fresh'`.
 *
 * `_lastUpdatedAt` is accepted for call-site symmetry with the HUD store's
 * `{ value, lastUpdatedAt, isStale }` shape (mirrors the `_loc` convention in
 * `network-speed.ts`); the staleness decision is made by the caller against
 * {@link STALE_THRESHOLD_MS}, so this argument does not alter the result here.
 */
export function getStalenessState(
	value: unknown,
	_lastUpdatedAt: number | null,
	isStale: boolean,
): StalenessState {
	if (value == null) return 'nodata';
	if (isStale === true) return 'stale';
	return 'fresh';
}
