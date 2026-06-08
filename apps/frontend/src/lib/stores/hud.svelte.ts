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

import type {
	Modem,
	ModemList,
	NetifMessage,
	SensorsStatus,
	UpdatingStatus,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { convertBytesToKbids } from "$lib/helpers/network-speed";
import { modemSignal } from "$lib/helpers/signal";
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

export type {
	HudConnectionState,
	HudSources,
	HudState,
	HudTimestamps,
	LinkSignal,
};

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
export function parseSensorNumber(
	raw: string | number | null | undefined,
): number | null {
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
export function parseCurrentAmps(
	raw: string | number | null | undefined,
): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*a/i.test(raw)) return n / 1000;
	return n;
}

/**
 * Parse a voltage reading and normalise to Volts. Values reported in
 * millivolts (e.g. "5100 mV") are converted to V.
 */
export function parseVolts(
	raw: string | number | null | undefined,
): number | null {
	const n = parseSensorNumber(raw);
	if (n == null) return null;
	if (typeof raw === "string" && /m\s*v/i.test(raw)) return n / 1000;
	return n;
}

/**
 * Map a modem's backend `status.connection` + `no_sim` flag onto the HUD's
 * simplified {@link LinkSignal.connectionState}. `no_sim` wins over everything
 * (a SIM-less modem can never be connected); otherwise `connected`/`scanning`
 * pass through and every other backend state (failed/registered/connecting or
 * a missing status) collapses to `disconnected`.
 */
export function modemConnectionState(
	modem: Modem,
): LinkSignal["connectionState"] {
	if (modem.no_sim === true) return "no_sim";
	switch (modem.status?.connection) {
		case "connected":
			return "connected";
		case "scanning":
			return "scanning";
		default:
			return "disconnected";
	}
}

/**
 * Build the ordered list of {@link LinkSignal} entries from wifi, modem, and
 * ethernet data. Throughput and `enabled` are joined from `netif` by `id`
 * (== ifname); ethernet links come from `netif` entries named `eth*` that are
 * enabled with an IP.
 *
 * Ordering is stable: wifi interfaces first (so wifi takes `linkIndex` 0 when
 * present), then modems, then ethernet in record order. The list is capped at
 * {@link MAX_LINKS} and `linkIndex` is the 0-based position.
 */
export function buildLinks(
	modems: ModemList | undefined,
	wifi: WifiStatus | undefined,
	netif: NetifMessage | undefined,
	modemsStale: boolean,
	wifiStale: boolean,
	fullyStale: boolean,
): LinkSignal[] {
	const links: LinkSignal[] = [];
	const netifEntries = netif ?? {};

	const throughputFor = (id: string): number =>
		convertBytesToKbids(netifEntries[id]?.tp ?? 0);
	const enabledFor = (id: string): boolean => netifEntries[id]?.enabled ?? true;

	for (const [key, iface] of Object.entries(wifi ?? {})) {
		// Key by the kernel interface name, not the wifi record key: the backend
		// may key the record by a radio/device id that differs from ifname, which
		// is what netif and the WiFi view both join on (mirrors the modem path).
		const id = iface.ifname || key;
		const active = iface.available?.find((network) => network.active);
		const isConnected = Boolean(active);
		links.push({
			id,
			type: "wifi",
			linkIndex: 0,
			signal: active && Number.isFinite(active.signal) ? active.signal : null,
			label: active?.ssid || "WiFi",
			isConnected,
			isStale: wifiStale || fullyStale,
			throughputKbps: throughputFor(id),
			enabled: enabledFor(id),
			connectionState: isConnected ? "connected" : "disconnected",
		});
	}

	for (const [key, modem] of Object.entries(modems ?? {})) {
		const id = modem.ifname || key;
		const connectionState = modemConnectionState(modem);
		links.push({
			id,
			type: "modem",
			linkIndex: 0,
			signal: modemSignal(modem),
			label: modem.name || modem.status?.network || "Modem",
			isConnected: connectionState === "connected",
			isStale: modemsStale || fullyStale,
			throughputKbps: throughputFor(id),
			enabled: enabledFor(id),
			connectionState,
		});
	}

	for (const [ifname, entry] of Object.entries(netifEntries)) {
		if (!ifname.startsWith("eth") || entry.enabled !== true || !entry.ip)
			continue;
		links.push({
			id: ifname,
			type: "ethernet",
			linkIndex: 0,
			signal: null,
			label: ifname,
			isConnected: true,
			isStale: fullyStale,
			throughputKbps: convertBytesToKbids(entry.tp ?? 0),
			enabled: entry.enabled,
			connectionState: "connected",
		});
	}

	return links
		.slice(0, MAX_LINKS)
		.map((link, index) => ({ ...link, linkIndex: index }));
}

/** Whether an update is currently in progress (boolean flag or progress object). */
export function isUpdateInProgress(
	updating: UpdatingStatus | undefined,
): boolean {
	if (updating == null || updating === false) return false;
	if (updating === true) return true;
	// Progress object: a finished update reports result === 0.
	return typeof updating === "object" && updating.result !== 0;
}

/** A timestamp is stale when it exists and is older than {@link STALE_THRESHOLD_MS}. Exported so components share the one global threshold. */
export function isTimestampStale(ts: number | null, now: number): boolean {
	if (ts == null) return false;
	return now - ts >= STALE_THRESHOLD_MS;
}

/**
 * Whether the staleness clock needs to keep ticking. The clock only advances
 * `now` so a staleness flag can flip; once nothing can transition, ticking is
 * waste — a foot-gun on an always-foreground kiosk with no `visibilitychange`
 * relief. A tick is needed while `streaming`, or while a dropped link is still
 * inside the {@link STALE_THRESHOLD_MS} window counting toward `isFullyStale`.
 *
 * `connectionLostAt` is the one timestamp safe to gate on: set once on
 * disconnect and never refreshed, it ages out deterministically. Refresh-driven
 * sources (sensors/modems/wifi) are intentionally excluded — gating on them
 * would keep an idle-connected device awake forever (the wakeup we remove); their
 * staleness still resolves while streaming, and `isFullyStale` covers disconnect.
 */
export function isClockTickNeeded(
	streaming: boolean,
	connectionLostAt: number | null,
	now: number,
): boolean {
	if (streaming) return true;
	return (
		connectionLostAt != null && now - connectionLostAt < STALE_THRESHOLD_MS
	);
}

/**
 * The full clock gate: tick only when the document is visible AND a tick is
 * actually {@link isClockTickNeeded | needed}. A hidden document never ticks,
 * even mid-stream — there is no one watching for data to go stale.
 */
export function shouldClockRun(
	visible: boolean,
	streaming: boolean,
	connectionLostAt: number | null,
	now: number,
): boolean {
	return visible && isClockTickNeeded(streaming, connectionLostAt, now);
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
	const isConnected =
		sources.isConnected && sources.connectionState === "connected";

	const isFullyStale =
		!isConnected &&
		timestamps.connectionLostAt != null &&
		now - timestamps.connectionLostAt >= STALE_THRESHOLD_MS;

	// Cadence-aware: only sensors (~1s push) dim on age; modems (~30s), wifi and
	// config (on-change) are connection-backed and dim solely on disconnect, so
	// healthy data never flickers stale in the gaps between slow backend pushes.
	const sensorsStale =
		isTimestampStale(timestamps.sensors, now) || isFullyStale;
	const streamingStale = isFullyStale;
	const modemsStale = isFullyStale;
	const wifiStale = isFullyStale;

	const sensors: SensorsStatus | undefined = sources.sensors;

	return {
		isStreaming: sources.isStreaming,
		isStreamingStale: streamingStale,
		bitrateKbps: sources.config?.max_br ?? null,
		isBitrateStale: streamingStale,

		links: buildLinks(
			sources.modems,
			sources.wifi,
			sources.netif,
			modemsStale,
			wifiStale,
			isFullyStale,
		),

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
// Staleness clock (rune-free, gated)
// ============================================

/** Whether the document is currently visible (headless/SSR → treated visible). */
function isDocumentVisible(): boolean {
	return typeof document === "undefined" || document.hidden !== true;
}

export interface StalenessClock {
	/** Re-evaluate the gate and start/stop the interval to match. */
	sync(): void;
	/** Whether the interval is currently running. */
	isRunning(): boolean;
	/** Stop the interval and dispose. */
	stop(): void;
}

/**
 * A self-gating staleness clock. Unlike a bare {@link setInterval} it only runs
 * while `shouldRun()` holds: {@link StalenessClock.sync} starts or stops it on
 * demand, and each tick re-checks `shouldRun()` so the interval stops itself the
 * instant the staleness window elapses. Rune-free so the gating is unit-testable
 * under plain vitest with fake timers.
 */
export function createStalenessClock(
	shouldRun: () => boolean,
	onTick: () => void,
	intervalMs: number = CLOCK_INTERVAL_MS,
): StalenessClock {
	let handle: ReturnType<typeof setInterval> | null = null;

	const stop = (): void => {
		if (handle !== null) {
			clearInterval(handle);
			handle = null;
		}
	};

	const start = (): void => {
		if (handle !== null) return;
		handle = setInterval(() => {
			onTick();
			if (!shouldRun()) stop();
		}, intervalMs);
	};

	return {
		sync: () => {
			if (shouldRun()) start();
			else stop();
		},
		isRunning: () => handle !== null,
		stop,
	};
}

// ============================================
// Reactive store (runes — lazily created)
// ============================================

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
	// freshly-read getters, which re-renders the frozen HUD/live fields once. The
	// only path that ticks the clock outside the gated interval.
	const releaseRefresh = onDisplayRefresh(() => {
		nowTick = Date.now();
	});

	// One-shot sensor-staleness latch (frozen-stream dimming).
	//
	// A FROZEN telemetry stream — WS frames stop arriving WITHOUT a disconnect, so
	// `connectionLostAt` never sets and the gated interval clock above stays parked —
	// must still dim live SoC values once they age past STALE_THRESHOLD_MS. Gating the
	// interval clock on sensor freshness instead would re-tick every second forever
	// (the exact foot-gun `isClockTickNeeded` deliberately avoids), so we use a single
	// deferred check, not an interval: every new sensor frame reschedules it, so in
	// steady state it is perpetually deferred and never fires; the instant frames stop
	// it fires exactly once, advancing `nowTick` so the derivation re-runs and
	// `isSensorsStale` flips. Disconnect staleness stays covered by the gated clock via
	// `connectionLostAt` -> `isFullyStale`.
	let sensorStaleLatch: ReturnType<typeof setTimeout> | null = null;
	const clearSensorStaleLatch = (): void => {
		if (sensorStaleLatch !== null) {
			clearTimeout(sensorStaleLatch);
			sensorStaleLatch = null;
		}
	};
	const armSensorStaleLatch = (sensorsAt: number): void => {
		clearSensorStaleLatch();
		// Fire one tick the moment this frame would age past the threshold. A fresher
		// frame before then re-arms (clearing this), so healthy data never ticks.
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
		// `getIsStreaming()` and `timestamps.connectionLostAt` as arguments, so
		// this effect re-runs on streaming flips and link drops/recoveries. The
		// visibility half is driven by the listener; the elapsed-window stop is
		// the clock's own per-tick self-check.
		$effect(() => {
			clock.sync();
		});
	});

	const snapshot = (): HudState =>
		deriveHudState(readSources(), timestamps, nowTick);

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
