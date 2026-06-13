/**
 * HUD store — Task 8 (barrel).
 *
 * Derives a render-ready {@link HudState} snapshot from the non-deprecated
 * `subscriptions.svelte.ts` getter surface. It is staleness-aware, survives
 * WebSocket disconnects (preserving last-known values), and never crashes on
 * no-SIM / null / sentinel signals.
 *
 * Architecture
 * ------------
 * The implementation is split by derivation domain under `hud/`; this file is a
 * barrel that re-exports the full public surface so every existing import path
 * into this module keeps working unchanged:
 *
 *   - `hud/constants.ts`     — STALE_THRESHOLD_MS, MAX_LINKS (shared constants)
 *   - `hud/soc-telemetry.ts` — sensor parsing (temperature / voltage / current)
 *   - `hud/link-status.ts`   — bonded-link signal derivation
 *   - `hud/staleness.ts`     — freshness fingerprints + the gated staleness clock
 *   - `hud/derive.ts`        — pure {@link deriveHudState} composition
 *   - `hud/store.svelte.ts`  — the lazy runes store + public selectors
 *
 * Every pure module is rune-free and fully unit-testable under a plain
 * (non-Svelte) vitest environment. Only `hud/store.svelte.ts` uses runes; it is
 * created lazily on first selector access and is never executed by the unit
 * tests.
 *
 * IMPORTANT: the store reads getters from `$lib/rpc/subscriptions.svelte`
 * directly — the richer, non-deprecated surface. Never import from
 * `$lib/stores/websocket-store.svelte` (deprecated wrapper).
 */

export type {
	HudConnectionState,
	HudSources,
	HudState,
	HudTimestamps,
	LinkSignal,
} from "$lib/types/hud";

// Shared constants (CLOCK_INTERVAL_MS stays internal to hud/).
export { MAX_LINKS, STALE_THRESHOLD_MS } from "./hud/constants";
// Pure HUD-state composition.
export { deriveHudState, isUpdateInProgress } from "./hud/derive";

// Bonded-link signal derivation.
export { buildLinks, modemConnectionState } from "./hud/link-status";
// SoC telemetry parsing.
export {
	parseCurrentAmps,
	parseSensorNumber,
	parseVolts,
} from "./hud/soc-telemetry";
// Staleness: per-interface freshness tracking + the gated clock.
export {
	createStalenessClock,
	type InterfaceFreshness,
	type InterfaceFreshnessMap,
	interfaceFingerprints,
	isClockTickNeeded,
	isTimestampStale,
	type StalenessClock,
	shouldClockRun,
	staleInterfaceIds,
	trackInterfaceFreshness,
} from "./hud/staleness";

// Reactive store + public selectors (runes — lazily created).
export {
	destroyHudStore,
	getHudState,
	getLinks,
	getSocTelemetry,
	getStreamingLiveState,
} from "./hud/store.svelte";
