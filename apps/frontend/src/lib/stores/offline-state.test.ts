/**
 * Task 16 — disconnect/reconnect UX + staleness integration.
 *
 * Exercises the *pure* connection-UX reducers/derivations and verifies the
 * HUD staleness model triggers within `STALE_THRESHOLD_MS` of a WS drop. These
 * are the same pure-function + lazy-runes split used by `hud.svelte.ts` (Task 8),
 * so nothing here executes Svelte runes.
 *
 * `hud.svelte.ts` statically imports `subscriptions.svelte.ts` (module-level
 * `$state`), which would throw under the plain (non-Svelte) vitest environment —
 * so we mock it. The derivations under test are pure and never call the getters.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: vi.fn(() => false),
	getConfig: vi.fn(() => undefined),
	getModems: vi.fn(() => undefined),
	getWifi: vi.fn(() => undefined),
	getSensors: vi.fn(() => undefined),
	getUpdating: vi.fn(() => null),
	getIsConnected: vi.fn(() => false),
	getConnectionState: vi.fn(() => "disconnected"),
}));

import type { HudSources, HudTimestamps } from "$lib/types/hud";

import {
	deriveConnectionUx,
	initialReconnectState,
	MAX_RECONNECT_ATTEMPTS,
	reduceConnection,
	type ReconnectState,
	shouldExpireSession,
} from "./connection-ux.svelte";
import { deriveHudState, STALE_THRESHOLD_MS } from "./hud.svelte";

// ============================================
// reduceConnection
// ============================================

describe("reduceConnection", () => {
	it("does not count the very first connecting as a reconnect attempt", () => {
		const s = reduceConnection(initialReconnectState(), "connecting");
		expect(s.attempts).toBe(0);
		expect(s.hasConnected).toBe(false);
	});

	it("resets attempts and clears the reboot latch on connected", () => {
		const prev: ReconnectState = { attempts: 4, hasConnected: true, rebooting: true };
		const s = reduceConnection(prev, "connected");
		expect(s).toEqual({ attempts: 0, hasConnected: true, rebooting: false });
	});

	it("counts each reconnect attempt after the first successful connection", () => {
		// connect → drop → connecting (attempt 1) → drop → connecting (attempt 2)
		let s = reduceConnection(initialReconnectState(), "connecting");
		s = reduceConnection(s, "connected");
		s = reduceConnection(s, "disconnected");
		s = reduceConnection(s, "connecting");
		expect(s.attempts).toBe(1);
		s = reduceConnection(s, "disconnected");
		s = reduceConnection(s, "connecting");
		expect(s.attempts).toBe(2);
	});

	it("preserves attempts and the reboot latch across a drop", () => {
		const prev: ReconnectState = { attempts: 3, hasConnected: true, rebooting: true };
		expect(reduceConnection(prev, "disconnected")).toEqual(prev);
		expect(reduceConnection(prev, "error")).toEqual(prev);
	});
});

// ============================================
// deriveConnectionUx
// ============================================

const baseInput = {
	isConnected: true,
	connectionState: "connected" as const,
	browserOnline: true,
	showOfflinePage: false,
	reconnectAttempts: 0,
	rebooting: false,
};

describe("deriveConnectionUx", () => {
	it("shows nothing while connected", () => {
		expect(deriveConnectionUx(baseInput)).toEqual({ mode: "connected", showBanner: false });
	});

	it("shows the reconnecting banner when WS is down but the browser is online", () => {
		const ux = deriveConnectionUx({
			...baseInput,
			isConnected: false,
			connectionState: "disconnected",
		});
		expect(ux).toEqual({ mode: "reconnecting", showBanner: true });
	});

	it("escalates to a hard failure once the retry budget is exhausted", () => {
		const ux = deriveConnectionUx({
			...baseInput,
			isConnected: false,
			connectionState: "disconnected",
			reconnectAttempts: MAX_RECONNECT_ATTEMPTS,
		});
		expect(ux).toEqual({ mode: "failed", showBanner: true });
	});

	it("shows the rebooting treatment even before the socket actually drops", () => {
		const ux = deriveConnectionUx({ ...baseInput, rebooting: true });
		expect(ux).toEqual({ mode: "rebooting", showBanner: true });
	});

	it("keeps the rebooting treatment while disconnected after a reboot", () => {
		const ux = deriveConnectionUx({
			...baseInput,
			isConnected: false,
			connectionState: "disconnected",
			rebooting: true,
			reconnectAttempts: MAX_RECONNECT_ATTEMPTS, // would otherwise be "failed"
		});
		expect(ux).toEqual({ mode: "rebooting", showBanner: true });
	});

	it("defers to the browser-offline page (never doubles up the banner)", () => {
		const ux = deriveConnectionUx({
			...baseInput,
			isConnected: false,
			connectionState: "disconnected",
			showOfflinePage: true,
		});
		expect(ux.showBanner).toBe(false);
	});

	it("suppresses the banner when the browser itself went offline", () => {
		const ux = deriveConnectionUx({
			...baseInput,
			isConnected: false,
			connectionState: "disconnected",
			browserOnline: false,
		});
		expect(ux.showBanner).toBe(false);
	});
});

// ============================================
// shouldExpireSession (auth-token expiry mid-session)
// ============================================

describe("shouldExpireSession", () => {
	it("treats a failure as expiry only once the operator has authenticated", () => {
		expect(shouldExpireSession(false, true)).toBe(true);
	});

	it("does not treat a first-time wrong password as a session expiry", () => {
		expect(shouldExpireSession(false, false)).toBe(false);
	});

	it("is false for a successful or pending auth result", () => {
		expect(shouldExpireSession(true, true)).toBe(false);
		expect(shouldExpireSession(undefined, true)).toBe(false);
	});

	it("models a reconnect whose re-auth fails → session expired", () => {
		// connect → authenticated → drop → reconnect → token rejected
		let s = reduceConnection(initialReconnectState(), "connecting");
		s = reduceConnection(s, "connected");
		const wasAuthed = true; // markAuthenticated() ran on the first success
		s = reduceConnection(s, "disconnected");
		s = reduceConnection(s, "connecting");
		s = reduceConnection(s, "connected"); // socket back, but auth re-sent
		// Backend rejects the stale token:
		expect(shouldExpireSession(false, wasAuthed)).toBe(true);
	});
});

// ============================================
// HUD staleness integration (Task 8 + Task 16 point D)
// ============================================

function makeSources(overrides: Partial<HudSources> = {}): HudSources {
	return {
		isStreaming: true,
		isConnected: true,
		connectionState: "connected",
		config: { max_br: 6000 },
		modems: undefined,
		wifi: undefined,
		sensors: { "SoC temperature": "50.0°C" },
		updating: false,
		...overrides,
	};
}

function makeTimestamps(value: number | null, overrides: Partial<HudTimestamps> = {}): HudTimestamps {
	return {
		streaming: value,
		sensors: value,
		modems: value,
		wifi: value,
		connectionLostAt: null,
		...overrides,
	};
}

const T0 = 1_000_000;

describe("HUD staleness on WS disconnect", () => {
	it("marks isFullyStale once STALE_THRESHOLD_MS elapses after the drop", () => {
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const justAfter = deriveHudState(sources, timestamps, T0 + STALE_THRESHOLD_MS + 1);
		expect(justAfter.isConnected).toBe(false);
		expect(justAfter.isFullyStale).toBe(true);
		// Fields dim but last-known values are preserved (not blanked).
		expect(justAfter.bitrateKbps).toBe(6000);
		expect(justAfter.temperature).toBe(50);
	});

	it("is not yet fully stale within the grace window after the drop", () => {
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const withinGrace = deriveHudState(sources, timestamps, T0 + STALE_THRESHOLD_MS - 1);
		expect(withinGrace.isFullyStale).toBe(false);
		expect(withinGrace.bitrateKbps).toBe(6000);
	});

	it("clears stale flags once the connection is restored and data freshens", () => {
		const now = T0 + 60_000;
		const restored = deriveHudState(
			makeSources(),
			makeTimestamps(now, { connectionLostAt: null }),
			now,
		);
		expect(restored.isConnected).toBe(true);
		expect(restored.isFullyStale).toBe(false);
		expect(restored.isStreamingStale).toBe(false);
		expect(restored.isSensorsStale).toBe(false);
	});
});
