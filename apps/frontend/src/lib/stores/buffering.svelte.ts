/**
 * Buffering (store-and-forward) store — surfaces cerastream's egress-spool state
 * (cerastream Task 32) in the HUD. The backend folds the additive `buffering` /
 * `spooled_bytes` / `data_headroom_bytes` / `disk_warning` fields off the engine
 * `status` event onto the existing `status` broadcast (it rides the engine event
 * bus, NOT the 5-signal device-stats channel). This store ingests that payload
 * and drives the calm "buffering — store & forward" indicator.
 *
 * Capability gate
 * ---------------
 * The state starts `null` (nothing observed). It only ever becomes non-null once
 * a `status` frame carries a `buffering` object — i.e. once the engine advertises
 * the feature. An older engine that never sends the field leaves the state `null`,
 * so the indicator renders nothing (the version/capability gate).
 *
 * Architecture (mirrors `stream-health.svelte.ts`)
 * ------------------------------------------------
 * The parse logic is a pure, rune-free function ({@link parseBufferingStatus}) so
 * it is unit-testable without a Svelte environment; only the store touches runes,
 * and it is a global singleton (dual-URL guard) shared by the `.ts` producer
 * (subscriptions) and the `.svelte` consumer (the HUD indicator).
 */

export interface BufferingState {
	active: boolean;
	spooledBytes: number | null;
	dataHeadroomBytes: number | null;
	diskWarning: boolean;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/**
 * Parse a raw `status.buffering` payload into a {@link BufferingState}. Returns
 * `null` for any missing / malformed payload (no `active` boolean), so a bad
 * frame never disturbs the last-known state and the capability gate stays honest.
 */
export function parseBufferingStatus(data: unknown): BufferingState | null {
	if (data === null || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (typeof d.active !== "boolean") return null;
	return {
		active: d.active,
		spooledBytes: numberOrNull(d.spooled_bytes),
		dataHeadroomBytes: numberOrNull(d.data_headroom_bytes),
		diskWarning: d.disk_warning === true,
	};
}

interface BufferingStore {
	ingest(data: unknown): void;
	getState(): BufferingState | null;
	isBuffering(): boolean;
	reset(): void;
	destroy(): void;
}

function createBufferingStore(): BufferingStore {
	let state = $state<BufferingState | null>(null);

	return {
		ingest: (data: unknown): void => {
			// `undefined` = this status frame carried no buffering field; leave the
			// last-known state untouched. A malformed payload also parses to `null`
			// and is ignored so it can never blank a live indicator.
			if (data === undefined) return;
			const next = parseBufferingStatus(data);
			if (next === null) return;
			state = next;
		},
		getState: () => state,
		isBuffering: () => state?.active === true,
		reset: () => {
			state = null;
		},
		destroy: () => {
			state = null;
		},
	};
}

const STORE_KEY = Symbol.for("ceraui.bufferingStore");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: BufferingStore };

const singletonStore: BufferingStore = ((): BufferingStore => {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY] ?? createBufferingStore();
	g[STORE_KEY] = existing;
	return existing;
})();

function store(): BufferingStore {
	return singletonStore;
}

/** Fold a raw `status.buffering` payload into the store. */
export function ingestBuffering(data: unknown): void {
	store().ingest(data);
}

/** The last-observed buffering state, or `null` before the engine advertises it. */
export function getBufferingState(): BufferingState | null {
	return store().getState();
}

/** Whether store-and-forward buffering is currently active. */
export function isBuffering(): boolean {
	return store().isBuffering();
}

/** Reset to the pre-broadcast state (e.g. on stream stop). */
export function resetBuffering(): void {
	store().reset();
}

/** Tear down the store. For tests/HMR. */
export function destroyBufferingStore(): void {
	const g = globalThis as GlobalWithStore;
	g[STORE_KEY]?.destroy();
	g[STORE_KEY] = undefined;
}
