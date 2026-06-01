/**
 * HUD store — Task 8
 *
 * Derives a render-ready {@link HudState} snapshot from the non-deprecated
 * `subscriptions.svelte.ts` getter surface. It is staleness-aware, survives
 * WebSocket disconnects (preserving last-known values), and never crashes on
 * no-SIM / null / sentinel signals.
 *
 * Architecture
 * ------------
 * The derivation is a *pure* function ({@link deriveHudState}) plus pure
 * helpers — none of them touch Svelte runes — so they are fully unit-testable
 * under a plain (non-Svelte) vitest environment. The reactive layer
 * ({@link createHudStore}) is created lazily on first selector access and is
 * the only place that uses runes; it is never executed by the unit tests.
 *
 * IMPORTANT: getters come from `$lib/rpc/subscriptions.svelte` directly — the
 * richer, non-deprecated surface. Never import from
 * `$lib/stores/websocket-store.svelte` (deprecated wrapper) here.
 */
import {
	getConfig,
	getConnectionState,
	getIsConnected,
	getIsStreaming,
	getModems,
	getSensors,
	getUpdating,
	getWifi,
} from "$lib/rpc/subscriptions.svelte";

import type {
	HudConnectionState,
	HudSources,
	HudState,
	HudTimestamps,
	LinkSignal,
} from "$lib/types/hud";
import type { Modem, ModemList, SensorsStatus, UpdatingStatus, WifiStatus } from "@ceraui/rpc/schemas";

export type { HudConnectionState, HudSources, HudState, HudTimestamps, LinkSignal };

// ============================================
// Constants
// ============================================

/** Data older than this (ms) without a refresh is considered stale. */
export const STALE_THRESHOLD_MS = 5000;

/** Maximum bonded links the HUD renders (maps to --link-1..--link-6). */
export const MAX_LINKS = 6;

/** How often the reactive clock ticks to re-evaluate staleness (ms). */
const CLOCK_INTERVAL_MS = 1000;

// ============================================
// Pure helpers (rune-free, unit-testable)
// ============================================

/**
 * Parse a numeric reading out of a sensor value that may be a number or a
 * unit-suffixed string (e.g. "43.2°C", "5.1 V"). Returns `null` on failure
 * rather than throwing or yielding NaN.
 */
export function parseSensorNumber(raw: string | number | null | undefined): number | null {
	if (raw == null) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	const match = raw.match(/-?\d+(?:\.\d+)?/);
	if (!match) return null;
	const n = Number.parseFloat(match[0]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse a current reading and normalise to Amps. Values reported in
 * milliamps (e.g. "1500 mA") are converted to A.
 */
export function parseCurrentAmps(raw: string | number | null | undefined): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*a/i.test(raw)) return n / 1000;
	return n;
}

/**
 * Parse a voltage reading and normalise to Volts. Values reported in
 * millivolts (e.g. "5100 mV") are converted to V.
 */
export function parseVolts(raw: string | number | null | undefined): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*v/i.test(raw)) return n / 1000;
	return n;
}

/**
 * Extract a usable signal percentage from a modem, or `null` when there is no
 * meaningful value (no-SIM, missing status, or a negative/sentinel reading).
 */
export function modemSignal(modem: Modem): number | null {
	if (modem.no_sim) return null;
	const signal = modem.status?.signal;
	if (signal == null) return null;
	if (!Number.isFinite(signal) || signal < 0) return null;
	return signal;
}

/**
 * Build the ordered list of {@link LinkSignal} entries from modem + wifi data.
 *
 * Ordering is stable: wifi interfaces first (so wifi takes `linkIndex` 0 when
 * present), then modems in record order. The list is capped at
 * {@link MAX_LINKS} and `linkIndex` is the 0-based position.
 */
export function buildLinks(
	modems: ModemList | undefined,
	wifi: WifiStatus | undefined,
	modemsStale: boolean,
	wifiStale: boolean,
	fullyStale: boolean,
): LinkSignal[] {
	const links: LinkSignal[] = [];

	for (const [ifname, iface] of Object.entries(wifi ?? {})) {
		const active = iface.available?.find((network) => network.active);
		links.push({
			id: ifname,
			type: "wifi",
			linkIndex: 0,
			signal: active && Number.isFinite(active.signal) ? active.signal : null,
			label: active?.ssid || "WiFi",
			isConnected: Boolean(active),
			isStale: wifiStale || fullyStale,
		});
	}

	for (const [key, modem] of Object.entries(modems ?? {})) {
		links.push({
			id: modem.ifname || key,
			type: "modem",
			linkIndex: 0,
			signal: modemSignal(modem),
			label: modem.name || modem.status?.network || "Modem",
			isConnected: modem.status?.connection === "connected",
			isStale: modemsStale || fullyStale,
		});
	}

	return links.slice(0, MAX_LINKS).map((link, index) => ({ ...link, linkIndex: index }));
}

/** Whether an update is currently in progress (boolean flag or progress object). */
export function isUpdateInProgress(updating: UpdatingStatus | undefined): boolean {
	if (updating == null || updating === false) return false;
	if (updating === true) return true;
	// Progress object: a finished update reports result === 0.
	return typeof updating === "object" && updating.result !== 0;
}

/** A timestamp is stale when it exists and is older than the threshold. */
function isTimestampStale(ts: number | null, now: number): boolean {
	if (ts == null) return false;
	return now - ts >= STALE_THRESHOLD_MS;
}

/**
 * Pure derivation: turn a point-in-time {@link HudSources} snapshot plus
 * {@link HudTimestamps} and a clock value into a complete {@link HudState}.
 *
 * Never throws on missing/partial/null inputs. Last-known values are kept on
 * disconnect; callers rely on the `*Stale` flags rather than nulling data.
 */
export function deriveHudState(
	sources: HudSources,
	timestamps: HudTimestamps,
	now: number,
): HudState {
	const isConnected = sources.isConnected && sources.connectionState === "connected";

	const isFullyStale =
		!isConnected &&
		timestamps.connectionLostAt != null &&
		now - timestamps.connectionLostAt >= STALE_THRESHOLD_MS;

	const streamingStale = isTimestampStale(timestamps.streaming, now) || isFullyStale;
	const sensorsStale = isTimestampStale(timestamps.sensors, now) || isFullyStale;
	const modemsStale = isTimestampStale(timestamps.modems, now);
	const wifiStale = isTimestampStale(timestamps.wifi, now);

	const sensors: SensorsStatus | undefined = sources.sensors;

	return {
		isStreaming: sources.isStreaming,
		isStreamingStale: streamingStale,
		bitrateKbps: sources.config?.max_br ?? null,
		isBitrateStale: streamingStale,

		links: buildLinks(sources.modems, sources.wifi, modemsStale, wifiStale, isFullyStale),

		temperature: parseSensorNumber(sensors?.["SoC temperature"]),
		voltage: parseVolts(sensors?.["SoC voltage"]),
		current: parseCurrentAmps(sensors?.["SoC current"]),
		isSensorsStale: sensorsStale,

		isConnected,
		isFullyStale,

		isUpdating: isUpdateInProgress(sources.updating),

		lastUpdatedAt: {
			streaming: timestamps.streaming,
			sensors: timestamps.sensors,
			modems: timestamps.modems,
		},
	};
}

// ============================================
// Reactive store (runes — lazily created)
// ============================================

interface HudStore {
	getHudState(): HudState;
	getStreamingLiveState(): { isLive: boolean; bitrateKbps: number | null; isStale: boolean };
	getLinks(): LinkSignal[];
	getSocTelemetry(): {
		temp: number | null;
		voltage: number | null;
		current: number | null;
		isStale: boolean;
	};
	destroy(): void;
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

			const connected = getIsConnected();
			if (connected) {
				timestamps.connectionLostAt = null;
			} else if (prevConnected !== false) {
				// First transition into a disconnected state.
				timestamps.connectionLostAt = t;
			}
			prevConnected = connected;
		});
	});

	const clock = setInterval(() => {
		nowTick = Date.now();
	}, CLOCK_INTERVAL_MS);

	const snapshot = (): HudState => deriveHudState(readSources(), timestamps, nowTick);

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
			clearInterval(clock);
			stopRoot();
		},
	};
}

let singleton: HudStore | null = null;

function store(): HudStore {
	return (singleton ??= createHudStore());
}

// ============================================
// Public selectors
// ============================================

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
