/**
 * HUD reactive store — the only rune-bearing HUD module.
 *
 * Wires the pure derivation ({@link deriveHudState} + helpers) to the
 * non-deprecated `subscriptions.svelte.ts` getter surface: staleness-aware,
 * survives WebSocket disconnects (last-known values preserved), never crashes on
 * no-SIM / null / sentinel signals. The reactive layer ({@link createHudStore})
 * is created lazily on first selector access and is never executed by the unit
 * tests. Getters come from `$lib/rpc/subscriptions.svelte` directly (the richer,
 * non-deprecated surface) — never the deprecated `websocket-store.svelte` wrapper.
 */

import {
	getConfig,
	getConnectionState,
	getIsConnected,
	getIsStreaming,
	getModems,
	getNetif,
	getSensors,
	getUpdating,
	getWifi,
} from "$lib/rpc/subscriptions.svelte";
import { onDisplayRefresh } from "$lib/stores/display-refresh.svelte";
import type {
	HudConnectionState,
	HudSources,
	HudState,
	HudTimestamps,
	LinkSignal,
} from "$lib/types/hud";
import { STALE_THRESHOLD_MS } from "./constants";
import { deriveHudState } from "./derive";
import {
	createStalenessClock,
	type InterfaceFreshnessMap,
	interfaceFingerprints,
	shouldClockRun,
	staleInterfaceIds,
	trackInterfaceFreshness,
} from "./staleness";

interface HudStore {
	getHudState(): HudState;
	getStreamingLiveState(): {
		isLive: boolean;
		bitrateKbps: number | null;
		isStale: boolean;
	};
	getLinks(): LinkSignal[];
	getSocTelemetry(): {
		temp: number | null;
		voltage: number | null;
		current: number | null;
		isStale: boolean;
	};
	destroy(): void;
}

/** Whether the document is currently visible (headless/SSR → treated visible). */
function isDocumentVisible(): boolean {
	return typeof document === "undefined" || document.hidden !== true;
}

/** Read the current raw getter values into a plain {@link HudSources}. */
function readSources(): HudSources {
	return {
		isStreaming: getIsStreaming(),
		isConnected: getIsConnected(),
		connectionState: getConnectionState() as HudConnectionState,
		config: getConfig(),
		modems: getModems(),
		wifi: getWifi(),
		netif: getNetif(),
		sensors: getSensors(),
		updating: getUpdating(),
	};
}

/**
 * Create the reactive HUD store. Uses runes, so this only ever runs inside the
 * Svelte app — never in the rune-free unit tests, which exercise the pure
 * functions above directly.
 */
function createHudStore(): HudStore {
	const timestamps = $state<HudTimestamps>({
		streaming: null,
		sensors: null,
		modems: null,
		wifi: null,
		connectionLostAt: null,
	});
	let nowTick = $state(Date.now());

	// Previous references for change detection (plain — not reactive).
	let prevStreaming: boolean | undefined;
	let prevConfig: unknown;
	let prevSensors: unknown;
	let prevModems: unknown;
	let prevWifi: unknown;
	let prevConnected: boolean | undefined;

	// Plain (like the prev* refs) so updating it inside the tracking effect never
	// re-triggers that effect; staleness still tracks nowTick via the snapshot.
	let freshness: InterfaceFreshnessMap = new Map();

	const clock = createStalenessClock(
		() =>
			shouldClockRun(
				isDocumentVisible(),
				getIsStreaming(),
				timestamps.connectionLostAt,
				Date.now(),
			),
		() => {
			nowTick = Date.now();
		},
	);

	// A kiosk never backgrounds, but a phone/desktop tab does: pause the clock
	// while hidden and re-evaluate the gate the moment it returns.
	const onVisibilityChange = (): void => clock.sync();
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	// Manual refresh (Task 12): advancing `nowTick` re-derives the snapshot from
	// freshly-read getters once — the only tick outside the gated interval.
	const releaseRefresh = onDisplayRefresh(() => {
		nowTick = Date.now();
	});

	// One-shot sensor-staleness latch (frozen-stream dimming).
	//
	// A FROZEN telemetry stream (WS frames stop WITHOUT a disconnect, so
	// `connectionLostAt` never sets and the gated clock stays parked) must still dim
	// live SoC values once they age past STALE_THRESHOLD_MS. Gating the interval clock
	// on sensor freshness would re-tick forever (the foot-gun `isClockTickNeeded`
	// avoids), so this is a single deferred check, not an interval: each new sensor
	// frame reschedules it (perpetually deferred in steady state); the instant frames
	// stop it fires exactly once, advancing `nowTick` so `isSensorsStale` flips.
	// Disconnect staleness stays covered by the gated clock via `isFullyStale`.
	let sensorStaleLatch: ReturnType<typeof setTimeout> | null = null;
	const clearSensorStaleLatch = (): void => {
		if (sensorStaleLatch !== null) {
			clearTimeout(sensorStaleLatch);
			sensorStaleLatch = null;
		}
	};
	const armSensorStaleLatch = (sensorsAt: number): void => {
		clearSensorStaleLatch();
		// Fire one tick the moment this frame ages past the threshold; a fresher frame
		// re-arms first (so healthy data never ticks).
		const delay = Math.max(0, sensorsAt + STALE_THRESHOLD_MS - Date.now());
		sensorStaleLatch = setTimeout(() => {
			sensorStaleLatch = null;
			nowTick = Date.now();
		}, delay);
	};

	const stopRoot = $effect.root(() => {
		$effect(() => {
			const t = Date.now();

			const isStreaming = getIsStreaming();
			const config = getConfig();
			if (isStreaming !== prevStreaming || config !== prevConfig) {
				timestamps.streaming = t;
				prevStreaming = isStreaming;
				prevConfig = config;
			}

			const sensors = getSensors();
			if (sensors !== prevSensors) {
				timestamps.sensors = t;
				prevSensors = sensors;
				armSensorStaleLatch(t);
			}

			const modems = getModems();
			if (modems !== prevModems) {
				timestamps.modems = t;
				prevModems = modems;
			}

			const wifi = getWifi();
			if (wifi !== prevWifi) {
				timestamps.wifi = t;
				prevWifi = wifi;
			}

			freshness = trackInterfaceFreshness(
				freshness,
				interfaceFingerprints(modems, wifi, getNetif()),
				t,
			);

			const connected = getIsConnected();
			if (connected) {
				timestamps.connectionLostAt = null;
			} else if (prevConnected !== false) {
				// First transition into a disconnected state.
				timestamps.connectionLostAt = t;
			}
			prevConnected = connected;
		});

		// Resume/stop the clock when a reactive gate input changes: `sync()` reads
		// `getIsStreaming()` + `timestamps.connectionLostAt`, so this re-runs on
		// streaming flips and link drops/recoveries (visibility is listener-driven).
		$effect(() => {
			clock.sync();
		});
	});

	const snapshot = (): HudState =>
		deriveHudState(
			readSources(),
			timestamps,
			nowTick,
			staleInterfaceIds(freshness, nowTick),
		);

	return {
		getHudState: () => snapshot(),
		getStreamingLiveState: () => {
			const state = snapshot();
			return {
				isLive: state.isStreaming,
				bitrateKbps: state.bitrateKbps,
				isStale: state.isStreamingStale || state.isBitrateStale,
			};
		},
		getLinks: () => snapshot().links,
		getSocTelemetry: () => {
			const state = snapshot();
			return {
				temp: state.temperature,
				voltage: state.voltage,
				current: state.current,
				isStale: state.isSensorsStale,
			};
		},
		destroy: () => {
			clock.stop();
			clearSensorStaleLatch();
			stopRoot();
			releaseRefresh();
			if (typeof document !== "undefined") {
				document.removeEventListener("visibilitychange", onVisibilityChange);
			}
		},
	};
}

let singleton: HudStore | null = null;

function store(): HudStore {
	singleton ??= createHudStore();
	return singleton;
}

/** Full reactive HUD snapshot. */
export function getHudState(): HudState {
	return store().getHudState();
}

/** Streaming live indicator: is-live + bitrate + staleness. */
export function getStreamingLiveState(): {
	isLive: boolean;
	bitrateKbps: number | null;
	isStale: boolean;
} {
	return store().getStreamingLiveState();
}

/** Ordered bonded-link signals (up to MAX_LINKS). */
export function getLinks(): LinkSignal[] {
	return store().getLinks();
}

/** SoC telemetry: temperature / voltage / current + staleness. */
export function getSocTelemetry(): {
	temp: number | null;
	voltage: number | null;
	current: number | null;
	isStale: boolean;
} {
	return store().getSocTelemetry();
}

/** Tear down the reactive store (timers + effect root). For tests/HMR. */
export function destroyHudStore(): void {
	singleton?.destroy();
	singleton = null;
}
