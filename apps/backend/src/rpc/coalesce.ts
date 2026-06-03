/**
 * Server-side sensor coalescing (last-value-per-type).
 *
 * A bandwidth-optimization SEAM, not a framework. It is a plain Map plus a
 * window check — no pub/sub, no event bus, no middleware. The broadcast path
 * consults `shouldCoalesce` before sending and, when a message passes,
 * records it via `updateCoalesceState`.
 *
 * For the LOCAL profile the per-type window equals that type's broadcast
 * interval, so only an EXACT duplicate emitted faster than its interval is
 * dropped; the first value of each interval (and any changed value) always
 * passes through. The observable local cadence is therefore unchanged. A
 * future REMOTE profile would lower these cadences by widening the windows —
 * design-only, no runtime wiring here.
 *
 * Both functions are pure helpers that operate on the passed-in map, mirroring
 * the `advanceSeq(map, type)` pattern in `events.ts` so they are trivially
 * unit-testable with an injected `now` (NO fake timers).
 */

export interface CoalesceEntry {
	/** The last value that was allowed through (broadcast) for this type. */
	value: unknown;
	/** Timestamp (ms) at which that value was emitted — anchors the window. */
	windowStart: number;
}

/** Per-type last-value store: `Map<type, { value, windowStart }>`. */
export type CoalesceState = Map<string, CoalesceEntry>;

/**
 * Per-type coalescing windows for the LOCAL profile, in milliseconds.
 *
 * Each window equals the type's broadcast interval (see the emitters):
 * - netif    5000ms (`network-interfaces.ts`)
 * - sensors  1000ms (`sensors.ts`)
 * - gateways 2000ms (`gateways.ts`)
 * - modems  30000ms (`modem-update-loop.ts`)
 *
 * Types not listed here are never coalesced (window resolves to 0).
 */
export const COALESCE_WINDOW_MS: Record<string, number> = {
	netif: 5000,
	sensors: 1000,
	gateways: 2000,
	modems: 30000,
};

/**
 * Window (ms) for a broadcast type. Unknown types return 0, which disables
 * coalescing for them (`shouldCoalesce` returns false when windowMs <= 0).
 */
export function getCoalesceWindowMs(type: string): number {
	return COALESCE_WINDOW_MS[type] ?? 0;
}

/**
 * Deterministic deep stringify with sorted object keys, so two structurally
 * equal payloads compare equal regardless of key insertion order.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(",")}}`;
}

/**
 * Pure predicate: should this `(type, value)` be coalesced (i.e. DROPPED)?
 *
 * Returns true only when a prior value exists for `type`, we are still within
 * `windowMs` of when that value was emitted, AND the new value is deeply
 * identical to it. The window boundary is exclusive — a value landing exactly
 * `windowMs` later is treated as a new interval and passes through, preserving
 * the local cadence.
 */
export function shouldCoalesce(
	map: CoalesceState,
	type: string,
	value: unknown,
	now: number,
	windowMs: number,
): boolean {
	if (windowMs <= 0) return false;
	const last = map.get(type);
	if (!last) return false;
	if (now - last.windowStart >= windowMs) return false; // window elapsed → pass
	return stableStringify(last.value) === stableStringify(value);
}

/**
 * Record a value that was allowed through, re-anchoring this type's window to
 * `now`. Call this only for messages that actually broadcast (not coalesced).
 */
export function updateCoalesceState(
	map: CoalesceState,
	type: string,
	value: unknown,
	now: number,
): void {
	map.set(type, { value, windowStart: now });
}
