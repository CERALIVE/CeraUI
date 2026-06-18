/**
 * Source-preference + fallback-state logic — Task 11
 *
 * Pure, rune-free helpers for the operator-ordered video-source preference and
 * the fallback-state visualization. Two contracts the rest of the UI relies on:
 *
 *   1. The preference list governs *operator-initiated* switching only. The
 *      engine's auto-failover is **sticky** — it does not consult this order and
 *      it does not auto-return to the preferred source once it has failed away.
 *   2. A "failover" is *derived*, never pushed: the engine is running a present
 *      source other than the operator's top preference because that preference
 *      went lost. There is no separate failover wire event.
 *
 * Everything here operates on plain data with no Svelte/runes dependency, so the
 * full lifecycle is unit-testable under the plain vitest environment.
 */

import type { CaptureDevice } from "@ceraui/rpc/schemas";

/** Per-source display state for the fallback visualization. */
export type SourceState = "active" | "lost" | "failed-over" | "idle";

/** Why the engine failed over. Sticky model: today only a lost source. */
export type FailoverReason = "source_lost";

/** A derived sticky-failover: the engine left `from` (now lost) for `to`. */
export interface FailoverEvent {
	/** input_id the engine failed away from (the operator's preferred source). */
	from: string;
	/** input_id the engine is now running. */
	to: string;
	reason: FailoverReason;
}

/** i18n key per failover reason, resolved by the consumer's `$LL` proxy. */
export const FAILOVER_REASON_KEYS: Record<FailoverReason, string> = {
	source_lost: "live.sourcePreference.failover.reasonSourceLost",
};

/** The video subset of a device list — preference applies to video only. */
export function videoSources<T extends { media_class: string }>(
	devices: readonly T[],
): T[] {
	return devices.filter((device) => device.media_class === "video");
}

/**
 * Move `id` one slot toward the front (`up`) or back (`down`), clamped at the
 * ends. Returns a new array; the input is never mutated. A no-op (fresh copy)
 * when `id` is absent or already at the relevant edge.
 */
export function reorderSource(
	order: readonly string[],
	id: string,
	direction: "up" | "down",
): string[] {
	const next = [...order];
	const i = next.indexOf(id);
	if (i === -1) return next;
	const j = direction === "up" ? i - 1 : i + 1;
	if (j < 0 || j >= next.length) return next;
	const a = next[i];
	const b = next[j];
	if (a === undefined || b === undefined) return next;
	next[i] = b;
	next[j] = a;
	return next;
}

/**
 * Reconcile a persisted preference order against the live device list: keep
 * persisted ids that are still present video sources (in persisted order), then
 * append any newly-seen video sources at the end. Drops stale ids and dedupes.
 */
export function normalizeOrder(
	devices: readonly CaptureDevice[],
	persisted: readonly string[] | undefined,
): string[] {
	const ids = videoSources(devices).map((device) => device.input_id);
	const present = new Set(ids);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of persisted ?? []) {
		if (present.has(id) && !seen.has(id)) {
			out.push(id);
			seen.add(id);
		}
	}
	for (const id of ids) {
		if (!seen.has(id)) {
			out.push(id);
			seen.add(id);
		}
	}
	return out;
}

/** Sort the video sources by `order`; unranked sources fall to the end. */
export function orderByPreference(
	devices: readonly CaptureDevice[],
	order: readonly string[],
): CaptureDevice[] {
	const rank = new Map(order.map((id, index) => [id, index]));
	return [...videoSources(devices)].sort((a, b) => {
		const ra = rank.get(a.input_id) ?? Number.MAX_SAFE_INTEGER;
		const rb = rank.get(b.input_id) ?? Number.MAX_SAFE_INTEGER;
		return ra - rb;
	});
}

/**
 * The display state of one source. `lost` wins over everything; a source the
 * engine failed *over to* is flagged `failed-over` (it is also the active one,
 * but the failover badge is the more useful signal); otherwise the active
 * source is `active` and the rest are `idle`.
 */
export function deriveSourceState(
	inputId: string,
	activeInput: string | undefined,
	lost: boolean,
	failover: FailoverEvent | null,
): SourceState {
	if (lost) return "lost";
	if (failover && inputId === failover.to) return "failed-over";
	if (inputId === activeInput) return "active";
	return "idle";
}

/**
 * Derive a sticky-failover from current state: the engine is running a present
 * source while the operator's top preference is lost/absent. Returns `null`
 * when the active source already IS the top preference, or when the top
 * preference is still present (a manual switch, not a failover).
 */
export function deriveFailover(
	order: readonly string[],
	devices: readonly CaptureDevice[],
	activeInput: string | undefined,
): FailoverEvent | null {
	if (!activeInput) return null;
	const byId = new Map(
		videoSources(devices).map((device) => [device.input_id, device]),
	);
	// The operator's declared #1 — taken from the RAW order so a vanished
	// top preference (dropped by normalizeOrder) is still recognized as the
	// source the engine failed away from.
	const preferred = order[0] ?? normalizeOrder(devices, order)[0];
	if (preferred === undefined || preferred === activeInput) return null;

	const preferredDevice = byId.get(preferred);
	const preferredLost = !preferredDevice || preferredDevice.lost === true;
	if (!preferredLost) return null;

	const activeDevice = byId.get(activeInput);
	if (!activeDevice || activeDevice.lost === true) return null;

	return { from: preferred, to: activeInput, reason: "source_lost" };
}

/** Dedup identity: one toast per distinct (from → to, reason) transition. */
export function failoverKey(event: FailoverEvent): string {
	return `${event.from}->${event.to}:${event.reason}`;
}
