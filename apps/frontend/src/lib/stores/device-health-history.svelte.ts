/**
 * Device-Health history — the only rune-bearing module behind the panel.
 *
 * Holds two timestamped rings (SoC temperature, 1-minute load average) plus the
 * 1 s playhead clock, and folds the dev-only encoder-load fixture in. All trace
 * math lives in the pure, rune-free `lib/components/custom/health-trace-view.ts`
 * sibling, mirroring the `hud/` derivation split.
 *
 * Hard constraints
 * ----------------
 * - **Not a second `rpcClient.onMessage` owner.** That is a CI-gated ban.
 *   `subscriptions.svelte.ts` remains the sole message owner; this store reads
 *   its existing getters inside an `$effect`.
 * - **Initialised app-wide from `main.ts`**, beside `initSubscriptions()` — NOT
 *   from the dialog. A ring that only started filling on dialog-open would show
 *   a blank instrument at the exact moment the operator needs history. Cost is
 *   ~400 numbers plus timestamps.
 * - **RAM-only, never persisted.** `docs/CONFIG_PERSISTENCE.md` has no home for
 *   telemetry history and none should be added.
 *
 * Why the rings key on the BROADCAST OBJECT rather than the parsed value:
 * two identical consecutive readings are a legitimate steady state, so a value
 * comparison would silently drop real samples and manufacture a pen-lift the
 * device never earned. Every broadcast lands as a fresh object, so reference
 * identity is the honest arrival edge.
 */

import {
	DEVICE_STATS_STALE_MS,
	deriveLaneSignalStatus,
	type LaneSignalStatus,
	MAX_LOAD_SAMPLES,
	MAX_TEMP_SAMPLES,
	TEMP_STALE_MS,
	type TraceSample,
	WINDOW_MS,
} from "$lib/components/custom/health-trace-view";
import {
	getDeviceStats,
	getIsStreaming,
	getSensors,
} from "$lib/rpc/subscriptions.svelte";
import { CLOCK_INTERVAL_MS } from "$lib/stores/hud/constants";
import { parseSensorNumber } from "$lib/stores/hud/soc-telemetry";
import {
	ENCODER_LOAD_UNAVAILABLE,
	type EncoderLoadReading,
} from "$lib/streaming/encoder-load";
import {
	ENCODER_LOAD_MOCK_PARAM,
	type EncoderLoadMockFlavor,
	mockEncoderLoadAt,
	parseEncoderLoadMockFlavor,
} from "$lib/streaming/encoder-load-mock";

/** The sensors key the RK3588 thermal collector publishes. */
const SOC_TEMPERATURE_KEY = "SoC temperature";

// A DIRECT `import.meta.env.DEV` literal, deliberately not `isDev` from
// `$lib/config`: Vite inlines the literal to `false` in production so Rollup
// prunes the fixture import entirely, and `$lib/config` additionally pulls the
// whole nav graph (DevTools included) into every consumer of this store.
const IS_DEV: boolean = import.meta.env.DEV;

interface DeviceHealthHistoryStore {
	getTemperatureSamples(): readonly TraceSample[];
	getLoadSamples(): readonly TraceSample[];
	getTemperatureStatus(): LaneSignalStatus;
	getLoadStatus(): LaneSignalStatus;
	getEncoderLoad(): EncoderLoadReading;
	getClockTick(): number;
	acquireClock(): () => void;
	destroy(): void;
}

function appendSample(
	ring: readonly TraceSample[],
	sample: TraceSample,
	now: number,
	maxSamples: number,
): TraceSample[] {
	const floor = now - WINDOW_MS;
	const next = ring.filter((s) => s.t >= floor);
	next.push(sample);
	return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}

/**
 * Read the dev `?health-mock=` flavour once. Production never calls this — the
 * inlined literal lets Rollup prune the whole fixture branch — so the parameter
 * has no effect on a shipped device.
 */
function resolveMockFlavor(): EncoderLoadMockFlavor {
	if (typeof window === "undefined") return parseEncoderLoadMockFlavor(null);
	return parseEncoderLoadMockFlavor(
		new URLSearchParams(window.location.search).get(ENCODER_LOAD_MOCK_PARAM),
	);
}

function createDeviceHealthHistoryStore(): DeviceHealthHistoryStore {
	let temperatureSamples = $state<readonly TraceSample[]>([]);
	let loadSamples = $state<readonly TraceSample[]>([]);
	let temperatureDeliveredAt = $state<number | null>(null);
	let loadDeliveredAt = $state<number | null>(null);
	let temperatureValue = $state<number | null>(null);
	let loadValue = $state<number | null>(null);
	let nowTick = $state(Date.now());

	let prevSensors: unknown;
	let prevDeviceStats: unknown;

	const mockFlavor = IS_DEV ? resolveMockFlavor() : undefined;

	// The playhead clock is refcounted by the panel rather than free-running: the
	// rings must fill from boot (the whole point of the app-wide init), but the
	// wall-clock right edge only means anything while the recorder is on screen.
	let clockHolders = 0;
	let clockHandle: ReturnType<typeof setInterval> | null = null;

	const startClock = (): void => {
		if (clockHandle !== null) return;
		clockHandle = setInterval(() => {
			nowTick = Date.now();
		}, CLOCK_INTERVAL_MS);
	};
	const stopClock = (): void => {
		if (clockHandle === null) return;
		clearInterval(clockHandle);
		clockHandle = null;
	};

	const stopRoot = $effect.root(() => {
		$effect(() => {
			const now = Date.now();

			const sensors = getSensors();
			if (sensors !== prevSensors) {
				prevSensors = sensors;
				if (sensors !== undefined) {
					const value = parseSensorNumber(
						(sensors as Record<string, unknown>)[SOC_TEMPERATURE_KEY] as
							| string
							| number
							| null
							| undefined,
					);
					temperatureDeliveredAt = now;
					temperatureValue = value;
					if (value !== null) {
						temperatureSamples = appendSample(
							temperatureSamples,
							{ t: now, v: value },
							now,
							MAX_TEMP_SAMPLES,
						);
					}
				}
			}

			const stats = getDeviceStats();
			if (stats !== prevDeviceStats) {
				prevDeviceStats = stats;
				if (stats !== undefined) {
					const value =
						typeof stats.cpuLoad1 === "number" &&
						Number.isFinite(stats.cpuLoad1)
							? stats.cpuLoad1
							: null;
					loadDeliveredAt = now;
					loadValue = value;
					if (value !== null) {
						loadSamples = appendSample(
							loadSamples,
							{ t: now, v: value },
							now,
							MAX_LOAD_SAMPLES,
						);
					}
				}
			}
		});
	});

	return {
		getTemperatureSamples: () => temperatureSamples,
		getLoadSamples: () => loadSamples,
		getTemperatureStatus: () =>
			deriveLaneSignalStatus(
				temperatureDeliveredAt,
				temperatureValue,
				nowTick,
				TEMP_STALE_MS,
			),
		getLoadStatus: () =>
			deriveLaneSignalStatus(
				loadDeliveredAt,
				loadValue,
				nowTick,
				DEVICE_STATS_STALE_MS,
			),
		getEncoderLoad: () =>
			mockFlavor === undefined
				? ENCODER_LOAD_UNAVAILABLE
				: mockEncoderLoadAt(mockFlavor, nowTick, getIsStreaming()),
		getClockTick: () => nowTick,
		acquireClock: () => {
			clockHolders++;
			startClock();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				clockHolders = Math.max(0, clockHolders - 1);
				if (clockHolders === 0) stopClock();
			};
		},
		destroy: () => {
			stopClock();
			clockHolders = 0;
			stopRoot();
		},
	};
}

let singleton: DeviceHealthHistoryStore | null = null;

function store(): DeviceHealthHistoryStore {
	singleton ??= createDeviceHealthHistoryStore();
	return singleton;
}

/**
 * Start filling the rings. Idempotent; called once from `main.ts` beside
 * `initSubscriptions()` so history exists before the panel is ever opened.
 */
export function initDeviceHealthHistory(): void {
	store();
}

export function getTemperatureSamples(): readonly TraceSample[] {
	return store().getTemperatureSamples();
}

export function getLoadSamples(): readonly TraceSample[] {
	return store().getLoadSamples();
}

export function getTemperatureStatus(): LaneSignalStatus {
	return store().getTemperatureStatus();
}

export function getLoadStatus(): LaneSignalStatus {
	return store().getLoadStatus();
}

/**
 * Per-core encoder load. On real hardware this is the honest unavailable
 * reading until a privileged backend collector lands
 * (`TD-encoder-load-telemetry`); in dev it is the `?health-mock=` fixture, and
 * every fixture reading carries `simulated: true`.
 */
export function getEncoderLoad(): EncoderLoadReading {
	return store().getEncoderLoad();
}

/** Wall-clock `now` for the playhead, advanced once per second while held. */
export function getHealthClockTick(): number {
	return store().getClockTick();
}

/** Run the playhead clock while the recorder is mounted. Returns the release. */
export function acquireHealthClock(): () => void {
	return store().acquireClock();
}

/** Tear down the store (timers + effect root). For tests and HMR. */
export function destroyDeviceHealthHistory(): void {
	singleton?.destroy();
	singleton = null;
}
