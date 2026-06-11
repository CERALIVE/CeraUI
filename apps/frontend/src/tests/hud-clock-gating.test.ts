/**
 * HUD staleness-clock gating — Task 5 (perf, G1/D4).
 *
 * The HUD store used to run an *unconditional* 1 Hz `setInterval` whose only job
 * is to advance `now` so a staleness flag can flip. On an always-foreground
 * kiosk (which never receives `visibilitychange` relief) that timer fires
 * forever, even while nothing can possibly transition — a real perf foot-gun.
 *
 * This suite pins the gated replacement. Mirroring `hud.test.ts` /
 * `connection-ux.svelte.ts`, every decision lives in *pure*, rune-free exported
 * functions ({@link isClockTickNeeded}, {@link shouldClockRun}) plus a rune-free,
 * timer-injectable clock ({@link createStalenessClock}) — so the actual
 * `setInterval` gating is unit-testable under plain vitest with fake timers, and
 * the reactive runes wrapper is never executed here.
 *
 * `hud.svelte.ts` statically imports `subscriptions.svelte`, whose module body
 * declares Svelte runes ($state). Mock it so importing the store never evaluates
 * those runes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: vi.fn(() => false),
	getConfig: vi.fn(() => undefined),
	getModems: vi.fn(() => undefined),
	getWifi: vi.fn(() => undefined),
	getNetif: vi.fn(() => undefined),
	getSensors: vi.fn(() => undefined),
	getUpdating: vi.fn(() => null),
	getIsConnected: vi.fn(() => false),
	getConnectionState: vi.fn(() => "disconnected"),
}));

import type {
	ConfigMessage,
	Modem,
	ModemList,
	NetifMessage,
	SensorsStatus,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import {
	createStalenessClock,
	deriveHudState,
	isClockTickNeeded,
	STALE_THRESHOLD_MS,
	shouldClockRun,
} from "$lib/stores/hud.svelte";
import type { HudSources, HudTimestamps } from "$lib/types/hud";

const T0 = 1_000_000;

// ============================================
// isClockTickNeeded — when a staleness tick is needed
// ============================================

describe("isClockTickNeeded — when a staleness tick is needed", () => {
	it("is needed while streaming, regardless of connection age", () => {
		expect(isClockTickNeeded(true, null, T0)).toBe(true);
		// Streaming wins even past the staleness window.
		expect(isClockTickNeeded(true, T0 - STALE_THRESHOLD_MS * 10, T0)).toBe(
			true,
		);
	});

	it("is NOT needed when idle and freshly connected (no link-loss pending)", () => {
		// Idle + fresh: not streaming, link is up (connectionLostAt === null).
		expect(isClockTickNeeded(false, null, T0)).toBe(false);
	});

	it("is needed while a dropped link is still inside the staleness window (near-stale)", () => {
		expect(isClockTickNeeded(false, T0, T0 + 1)).toBe(true);
		expect(isClockTickNeeded(false, T0, T0 + STALE_THRESHOLD_MS - 1)).toBe(
			true,
		);
	});

	it("is NOT needed once the dropped link has aged out of the staleness window", () => {
		// At/after the threshold the link is already fully stale — no further tick
		// can change the output, so the clock must NOT keep waking.
		expect(isClockTickNeeded(false, T0, T0 + STALE_THRESHOLD_MS)).toBe(false);
		expect(isClockTickNeeded(false, T0, T0 + STALE_THRESHOLD_MS + 1)).toBe(
			false,
		);
	});
});

// ============================================
// shouldClockRun — visibility gates the clock
// ============================================

describe("shouldClockRun — visibility gates the clock", () => {
	it("never runs while the document is hidden, even mid-stream", () => {
		expect(shouldClockRun(false, true, null, T0)).toBe(false);
	});

	it("never runs while hidden, even with a link dropping inside the window", () => {
		expect(shouldClockRun(false, false, T0, T0 + 1)).toBe(false);
	});

	it("runs when visible and a tick is needed (streaming)", () => {
		expect(shouldClockRun(true, true, null, T0)).toBe(true);
	});

	it("runs when visible and a dropped link is near-stale", () => {
		expect(shouldClockRun(true, false, T0, T0 + STALE_THRESHOLD_MS - 1)).toBe(
			true,
		);
	});

	it("stays idle when visible but nothing needs a tick", () => {
		// Visible + idle + fresh → still no reason to tick.
		expect(shouldClockRun(true, false, null, T0)).toBe(false);
	});
});

// ============================================
// createStalenessClock — gated interval lifecycle
// ============================================

describe("createStalenessClock — gated interval lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not start, and never ticks, while the gate is closed (hidden/idle)", () => {
		const onTick = vi.fn();
		const clock = createStalenessClock(() => false, onTick);

		clock.sync();
		expect(clock.isRunning()).toBe(false);

		vi.advanceTimersByTime(10_000);
		expect(onTick).not.toHaveBeenCalled();

		clock.stop();
	});

	it("ticks once per interval while the gate is open (streaming/near-stale)", () => {
		const onTick = vi.fn();
		const clock = createStalenessClock(() => true, onTick);

		clock.sync();
		expect(clock.isRunning()).toBe(true);

		vi.advanceTimersByTime(3000);
		expect(onTick).toHaveBeenCalledTimes(3);

		clock.stop();
	});

	it("self-stops the instant the staleness window elapses (no idle wakeups)", () => {
		const onTick = vi.fn();
		// Open until the link-loss window closes, then closed forever — exactly the
		// `now - connectionLostAt < STALE_THRESHOLD_MS` shape from the real store.
		const deadline = T0 + STALE_THRESHOLD_MS;
		const clock = createStalenessClock(() => Date.now() < deadline, onTick);

		clock.sync();
		expect(clock.isRunning()).toBe(true);

		// Ticks fire at +1s..+5s; the +5s tick crosses the deadline and self-stops.
		vi.advanceTimersByTime(STALE_THRESHOLD_MS);
		expect(onTick).toHaveBeenCalledTimes(STALE_THRESHOLD_MS / 1000);
		expect(clock.isRunning()).toBe(false);

		// No further wakeups once the window has elapsed.
		vi.advanceTimersByTime(60_000);
		expect(onTick).toHaveBeenCalledTimes(STALE_THRESHOLD_MS / 1000);

		clock.stop();
	});

	it("resumes on demand after the gate reopens (visibility / stream restart)", () => {
		const onTick = vi.fn();
		let open = false;
		const clock = createStalenessClock(() => open, onTick);

		clock.sync();
		expect(clock.isRunning()).toBe(false);
		vi.advanceTimersByTime(3000);
		expect(onTick).not.toHaveBeenCalled();

		// Gate reopens (tab visible again, or streaming restarted).
		open = true;
		clock.sync();
		expect(clock.isRunning()).toBe(true);
		vi.advanceTimersByTime(2000);
		expect(onTick).toHaveBeenCalledTimes(2);

		clock.stop();
	});

	it("is idempotent: syncing repeatedly does not stack intervals", () => {
		const onTick = vi.fn();
		const clock = createStalenessClock(() => true, onTick);

		clock.sync();
		clock.sync();
		clock.sync();

		vi.advanceTimersByTime(1000);
		// A single interval — three syncs must not triple the tick rate.
		expect(onTick).toHaveBeenCalledTimes(1);

		clock.stop();
	});

	it("stops cleanly: no ticks after stop()", () => {
		const onTick = vi.fn();
		const clock = createStalenessClock(() => true, onTick);

		clock.sync();
		vi.advanceTimersByTime(1000);
		expect(onTick).toHaveBeenCalledTimes(1);

		clock.stop();
		expect(clock.isRunning()).toBe(false);
		vi.advanceTimersByTime(10_000);
		expect(onTick).toHaveBeenCalledTimes(1);
	});
});

// ============================================
// deriveHudState — staleness output unchanged vs baseline
//
// Gating only changes WHEN `now` advances; the pure derivation (and the 5s
// threshold) must be byte-for-byte unchanged. These mirror the canonical
// `hud.test.ts` staleness fixtures and assert the same flags fall out.
// ============================================

function makeModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "CarrierA",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4G",
			signal: 80,
			roaming: false,
			network: "CarrierA",
		},
		...overrides,
	};
}

const wifiFixture: WifiStatus = {
	wlan0: {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "00:11:22",
		available: [
			{ active: true, ssid: "MyNet", signal: 65, security: "WPA2", freq: 5180 },
		],
		saved: {},
		supports_hotspot: false,
	},
};

const sensorsFixture: SensorsStatus = {
	"SoC temperature": "43.2°C",
	"SoC current": "1500 mA",
	"SoC voltage": "5.1 V",
};

const configFixture: ConfigMessage = { max_br: 6000 };

const netifFixture: NetifMessage = {
	wwan0: { tp: 128_000, enabled: true, ip: "10.0.0.2" },
	wlan0: { tp: 64_000, enabled: true, ip: "10.0.0.3" },
};

function makeSources(overrides: Partial<HudSources> = {}): HudSources {
	return {
		isStreaming: true,
		isConnected: true,
		connectionState: "connected",
		config: configFixture,
		modems: { modem1: makeModem() } as ModemList,
		wifi: wifiFixture,
		netif: netifFixture,
		sensors: sensorsFixture,
		updating: false,
		...overrides,
	};
}

function makeTimestamps(
	value: number | null,
	overrides: Partial<HudTimestamps> = {},
): HudTimestamps {
	return {
		streaming: value,
		sensors: value,
		modems: value,
		wifi: value,
		connectionLostAt: null,
		...overrides,
	};
}

describe("deriveHudState — staleness output unchanged vs baseline", () => {
	it("connected + fresh: nothing is stale (happy path)", () => {
		const state = deriveHudState(makeSources(), makeTimestamps(T0), T0);
		expect(state.isSensorsStale).toBe(false);
		expect(state.isStreamingStale).toBe(false);
		expect(state.isBitrateStale).toBe(false);
		expect(state.isFullyStale).toBe(false);
		expect(state.links.every((l) => !l.isStale)).toBe(true);
	});

	it("connected: only fast sensors dim past the 5s threshold", () => {
		const now = T0 + STALE_THRESHOLD_MS + 1;
		const state = deriveHudState(makeSources(), makeTimestamps(T0), now);
		expect(state.isSensorsStale).toBe(true);
		// Connection-backed values must NOT dim on age while connected.
		expect(state.isStreamingStale).toBe(false);
		expect(state.isBitrateStale).toBe(false);
		expect(state.links.every((l) => !l.isStale)).toBe(true);
		expect(state.isFullyStale).toBe(false);
	});

	it("connected: sensors are NOT stale one ms before the threshold", () => {
		const now = T0 + STALE_THRESHOLD_MS - 1;
		const state = deriveHudState(makeSources(), makeTimestamps(T0), now);
		expect(state.isSensorsStale).toBe(false);
	});

	it("disconnect: fully stale past the threshold, last-known values preserved", () => {
		const now = T0 + STALE_THRESHOLD_MS + 1;
		const sources = makeSources({
			isConnected: false,
			connectionState: "disconnected",
		});
		const state = deriveHudState(
			sources,
			makeTimestamps(T0, { connectionLostAt: T0 }),
			now,
		);
		expect(state.isFullyStale).toBe(true);
		expect(state.links.every((l) => l.isStale)).toBe(true);
		// No nulling — last-known data is retained.
		expect(state.bitrateKbps).toBe(6000);
		expect(state.temperature).toBe(43.2);
	});

	it("disconnect: not fully stale within the grace window", () => {
		const now = T0 + 100;
		const sources = makeSources({
			isConnected: false,
			connectionState: "disconnected",
		});
		const state = deriveHudState(
			sources,
			makeTimestamps(T0, { connectionLostAt: T0 }),
			now,
		);
		expect(state.isFullyStale).toBe(false);
		expect(state.bitrateKbps).toBe(6000);
	});

	it("disconnect: the 5s boundary is inclusive (>=)", () => {
		const now = T0 + STALE_THRESHOLD_MS;
		const sources = makeSources({
			isConnected: false,
			connectionState: "disconnected",
		});
		const state = deriveHudState(
			sources,
			makeTimestamps(T0, { connectionLostAt: T0 }),
			now,
		);
		expect(state.isFullyStale).toBe(true);
	});
});
