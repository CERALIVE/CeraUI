/**
 * Stream-health store — Task 14
 *
 * Surfaces the device's tri-state stream-liveness rollup (Task 13) in the UI.
 * The backend broadcasts a `health` event (`HEALTH_EVENT_TYPE` in
 * `modules/streaming/health.ts`) carrying a {@link StreamHealthOutput} ONLY when
 * the rolled-up state transitions, on the 5s heartbeat tick. This store folds
 * each broadcast into a current/previous {@link HealthSnapshot}, drives the HUD
 * indicator, and raises a non-blocking toast on the meaningful transitions
 * (degraded, dead, recovered).
 *
 * Architecture (mirrors `hud.svelte.ts` / `connection-ux.svelte.ts` /
 * `notifications.svelte.ts`)
 * --------------------------------------------------------------------------
 * All decision logic lives in *pure*, rune-free exported functions
 * ({@link parseHealthState}, {@link reduceHealth},
 * {@link notificationForTransition}) so they are fully unit-testable. The
 * reactive layer ({@link createStreamHealthStore}) is the only place that
 * touches Svelte runes.
 *
 * Ingestion source
 * ----------------
 * `subscriptions.svelte.ts handleMessage` forwards the `health` broadcast into
 * {@link ingestStreamHealth} (single, seq-guarded message pipeline — same path
 * the HUD and notifications use). The toast is raised through the central
 * notification store (`notifications.svelte.ts`), reusing the established
 * dedup-by-`name` + i18n-key resolution from Task 10.
 */
import type { Notification } from "@ceraui/rpc/schemas";

import { push as pushNotification } from "$lib/stores/notifications.svelte";

// ============================================
// Types
// ============================================

/**
 * The render-ready health indicator. The backend broadcasts
 * `healthy` | `degraded` | `dead` | `idle` (`idle` = the truthful non-streaming
 * posture, device-stability Todo 19); `unknown` is the pre-broadcast state before
 * any `health` event has arrived (and after a reset on stream stop).
 */
export type HealthIndicator =
	| "healthy"
	| "degraded"
	| "dead"
	| "idle"
	| "unknown";

/** Current health plus the state it transitioned from (for edge detection). */
export interface HealthSnapshot {
	current: HealthIndicator;
	previous: HealthIndicator;
}

/**
 * Per-subsystem breakdown carried by every `health` broadcast (Task 13's
 * `StreamHealthOutput`), surfaced in the HUD rollup so the UI shows why the
 * rolled-up state is what it is, not just the tri-state dot. `state` is always
 * concrete here; a broadcast never carries `unknown`.
 */
/**
 * The single most-actionable cause behind a non-healthy rollup, mirrored from
 * the backend `reason` field. Present only when the stream is degraded or dead.
 */
export interface HealthReason {
	component: string;
	detail: string;
}

export interface HealthRollup {
	state: Exclude<HealthIndicator, "unknown">;
	reason?: HealthReason;
	// `null` = unknown (idle posture / tri-state SRT); a boolean is a real
	// streaming observation. Never coerce `null` to `false` — that is the
	// idle-vs-dead / stable-vs-unknown distinction the HUD renders.
	process: { alive: boolean | null };
	frames: { advancing: boolean | null; count: number | null };
	srt: { reconnecting: boolean | null; reconnectCount: number };
	bond: { linkCount: number; activeLinks: number };
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
	"healthy",
	"degraded",
	"dead",
	"idle",
]);

// ============================================
// Pure logic (rune-free, unit-testable)
// ============================================

/** The neutral starting point: nothing observed yet. */
export function initialHealthSnapshot(): HealthSnapshot {
	return { current: "unknown", previous: "unknown" };
}

/**
 * Extract the {@link HealthIndicator} from a raw `health` broadcast payload.
 * Reads only `state`; any malformed / missing / unrecognised value collapses to
 * `"unknown"` rather than throwing, so a bad frame can never crash the HUD.
 */
export function parseHealthState(data: unknown): HealthIndicator {
	if (data === null || typeof data !== "object") return "unknown";
	const state = (data as { state?: unknown }).state;
	if (typeof state === "string" && KNOWN_STATES.has(state)) {
		return state as HealthIndicator;
	}
	return "unknown";
}

function asCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: 0;
}

// Preserve an explicit `null` (unknown / idle) — only a literal `true` is a
// positive observation; `false`/missing collapse to `false`, `null` stays `null`.
function asNullableFlag(value: unknown): boolean | null {
	if (value === null) return null;
	return value === true;
}

function asNullableCount(value: unknown): number | null {
	if (value === null) return null;
	return asCount(value);
}

/**
 * Extract the full {@link HealthRollup} from a raw `health` broadcast payload.
 * Returns `null` when the payload has no recognised tri-state (so the consumer
 * keeps its last-known rollup rather than blanking). Every sub-field is coerced
 * defensively (missing booleans collapse to `false`, missing/invalid counts to
 * `0`) so a partial frame can never crash the HUD rollup.
 */
function parseHealthReason(value: unknown): HealthReason | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const component = (value as { component?: unknown }).component;
	const detail = (value as { detail?: unknown }).detail;
	if (typeof component === "string" && typeof detail === "string") {
		return { component, detail };
	}
	return undefined;
}

export function parseHealthRollup(data: unknown): HealthRollup | null {
	const state = parseHealthState(data);
	if (state === "unknown") return null;
	const d = data as Record<string, unknown>;
	const process = (d.process ?? {}) as Record<string, unknown>;
	const frames = (d.frames ?? {}) as Record<string, unknown>;
	const srt = (d.srt ?? {}) as Record<string, unknown>;
	const bond = (d.bond ?? {}) as Record<string, unknown>;
	const reason = parseHealthReason(d.reason);
	return {
		state,
		...(reason ? { reason } : {}),
		process: { alive: asNullableFlag(process.alive) },
		frames: {
			advancing: asNullableFlag(frames.advancing),
			count: asNullableCount(frames.count),
		},
		srt: {
			reconnecting: asNullableFlag(srt.reconnecting),
			reconnectCount: asCount(srt.reconnectCount),
		},
		bond: {
			linkCount: asCount(bond.linkCount),
			activeLinks: asCount(bond.activeLinks),
		},
	};
}

/**
 * Fold a freshly-observed indicator into the snapshot: the new value becomes
 * `current`, and the prior `current` is preserved as `previous`. A repeat of the
 * same state still advances `previous` to that state (so `current === previous`
 * marks "no transition").
 */
export function reduceHealth(
	prev: HealthSnapshot,
	next: HealthIndicator,
): HealthSnapshot {
	return { current: next, previous: prev.current };
}

/**
 * The toast (if any) to raise for a `previous → current` transition. Returns
 * `null` when no notification is warranted:
 *   - no state change,
 *   - any settle into `unknown` (never alarms),
 *   - the initial `unknown → healthy` (a clean start is silent).
 *
 * Notifications dedup by `name`, so rapid flapping into the same state replaces
 * the prior toast rather than stacking — bounded under load.
 */
export function notificationForTransition(
	previous: HealthIndicator,
	current: HealthIndicator,
): Notification | null {
	if (current === previous) return null;

	switch (current) {
		case "dead":
			return {
				name: "stream-health-dead",
				type: "error",
				key: "notifications.streamHealthDead",
				msg: "Stream is down",
				is_dismissable: true,
				is_persistent: false,
				duration: 6,
			};
		case "degraded":
			return {
				name: "stream-health-degraded",
				type: "warning",
				key: "notifications.streamHealthDegraded",
				msg: "Stream health degraded",
				is_dismissable: true,
				is_persistent: false,
				duration: 5,
			};
		case "healthy":
			if (previous === "degraded" || previous === "dead") {
				return {
					name: "stream-health-recovered",
					type: "success",
					key: "notifications.streamHealthRecovered",
					msg: "Stream health recovered",
					is_dismissable: true,
					is_persistent: false,
					duration: 4,
				};
			}
			return null;
		case "idle":
			// Idle is the calm non-streaming posture — never an alarm, and stopping
			// a stream (live/degraded/dead → idle) must not raise a toast.
			return null;
		default:
			return null;
	}
}

// ============================================
// Reactive store (runes — global singleton)
// ============================================

interface StreamHealthStore {
	ingest(data: unknown): void;
	getState(): HealthIndicator;
	getSnapshot(): HealthSnapshot;
	getRollup(): HealthRollup | null;
	reset(): void;
	destroy(): void;
}

function createStreamHealthStore(): StreamHealthStore {
	let snapshot = $state<HealthSnapshot>(initialHealthSnapshot());
	let rollup = $state<HealthRollup | null>(null);

	const ingest = (data: unknown): void => {
		const next = parseHealthState(data);
		// A malformed / unrecognised frame parses to `unknown`; never let it grey
		// out the last-known-good indicator. `unknown` is reachable only as the
		// pre-broadcast initial state or via an explicit reset(), never a broadcast.
		if (next === "unknown") return;
		const notification = notificationForTransition(snapshot.current, next);
		snapshot = reduceHealth(snapshot, next);
		rollup = parseHealthRollup(data);
		if (notification) pushNotification(notification);
	};

	return {
		ingest,
		getState: () => snapshot.current,
		getSnapshot: () => snapshot,
		getRollup: () => rollup,
		reset: () => {
			snapshot = initialHealthSnapshot();
			rollup = null;
		},
		destroy: () => {
			snapshot = initialHealthSnapshot();
			rollup = null;
		},
	};
}

// Held on `globalThis` (global-registry symbol) AND created eagerly at module
// load — the same dual-URL guard `notifications.svelte.ts` uses: in Vite dev
// this `.svelte.ts` module is served under two browser URLs (one for `.svelte`
// importers like HudBar, one for `.ts` importers like subscriptions), so it
// evaluates twice. The shared key gives both copies ONE store, so the producer
// (subscriptions) and the consumer (HudBar) agree on a single reactive snapshot.
const STORE_KEY = Symbol.for("ceraui.streamHealthStore");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: StreamHealthStore };

const singletonStore: StreamHealthStore = ((): StreamHealthStore => {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY] ?? createStreamHealthStore();
	g[STORE_KEY] = existing;
	return existing;
})();

function store(): StreamHealthStore {
	return singletonStore;
}

// ============================================
// Public selectors / actions
// ============================================

/** Fold a raw `health` broadcast payload into the store, raising any transition toast. */
export function ingestStreamHealth(data: unknown): void {
	store().ingest(data);
}

/** The current health indicator for the HUD (`unknown` until the first broadcast). */
export function getStreamHealthState(): HealthIndicator {
	return store().getState();
}

/** Current + previous health, for transition-aware consumers. */
export function getStreamHealthSnapshot(): HealthSnapshot {
	return store().getSnapshot();
}

/**
 * The last-broadcast per-subsystem breakdown (process/frames/SRT/bond), or
 * `null` before the first `health` broadcast. Drives the HUD rollup.
 */
export function getStreamHealthRollup(): HealthRollup | null {
	return store().getRollup();
}

/** Reset to `unknown` (e.g. on stream stop). */
export function resetStreamHealth(): void {
	store().reset();
}

/** Tear down the store. For tests/HMR. */
export function destroyStreamHealthStore(): void {
	const g = globalThis as GlobalWithStore;
	g[STORE_KEY]?.destroy();
	g[STORE_KEY] = undefined;
}
