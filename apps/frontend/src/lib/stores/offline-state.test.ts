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

import type { HudSources, HudTimestamps } from "../types/hud";

import {
	deriveConnectionSurfaceUx,
	deriveConnectionUx,
	effectiveDisconnectedSince,
	hasOutlastedBannerGrace,
	initialReconnectState,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BANNER_GRACE_MS,
	type ReconnectState,
	reduceBrowserOfflineSince,
	reduceConnection,
	shouldExpireSession,
	shouldRunBannerGraceClock,
} from "./connection-ux.svelte";
import { deriveHudState, STALE_THRESHOLD_MS } from "./hud.svelte";

/** Fixed epoch so the injected-time assertions read as offsets, not wall-clock. */
const CONN_T0 = 1_700_000_000_000;

// ============================================
// reduceConnection
// ============================================

describe("reduceConnection", () => {
	it("does not count the very first connecting as a reconnect attempt", () => {
		const s = reduceConnection(initialReconnectState(), "connecting", CONN_T0);
		expect(s.attempts).toBe(0);
		expect(s.hasConnected).toBe(false);
	});

	it("resets attempts and clears the reboot latch on connected", () => {
		const prev: ReconnectState = {
			attempts: 4,
			hasConnected: true,
			rebooting: true,
			disconnectedSince: CONN_T0,
		};
		const s = reduceConnection(prev, "connected", CONN_T0 + 100);
		expect(s).toEqual({
			attempts: 0,
			hasConnected: true,
			rebooting: false,
			disconnectedSince: null,
		});
	});

	it("counts each reconnect attempt after the first successful connection", () => {
		// connect → drop → connecting (attempt 1) → drop → connecting (attempt 2)
		let s = reduceConnection(initialReconnectState(), "connecting", CONN_T0);
		s = reduceConnection(s, "connected", CONN_T0 + 1);
		s = reduceConnection(s, "disconnected", CONN_T0 + 2);
		s = reduceConnection(s, "connecting", CONN_T0 + 3);
		expect(s.attempts).toBe(1);
		s = reduceConnection(s, "disconnected", CONN_T0 + 4);
		s = reduceConnection(s, "connecting", CONN_T0 + 5);
		expect(s.attempts).toBe(2);
	});

	it("preserves attempts and the reboot latch across a drop", () => {
		const prev: ReconnectState = {
			attempts: 3,
			hasConnected: true,
			rebooting: true,
			disconnectedSince: CONN_T0,
		};
		expect(reduceConnection(prev, "disconnected", CONN_T0 + 50)).toEqual(prev);
		expect(reduceConnection(prev, "error", CONN_T0 + 50)).toEqual(prev);
	});

	it("stamps the disconnect start once and never refreshes it mid-drop", () => {
		let s = reduceConnection(initialReconnectState(), "connected", CONN_T0);
		expect(s.disconnectedSince).toBeNull();

		s = reduceConnection(s, "disconnected", CONN_T0 + 100);
		expect(s.disconnectedSince).toBe(CONN_T0 + 100);

		// Every retry inside the same drop keeps the ORIGINAL stamp — re-stamping
		// would restart the grace window and the banner could never appear.
		s = reduceConnection(s, "connecting", CONN_T0 + 900);
		s = reduceConnection(s, "disconnected", CONN_T0 + 1800);
		s = reduceConnection(s, "connecting", CONN_T0 + 2700);
		expect(s.disconnectedSince).toBe(CONN_T0 + 100);

		s = reduceConnection(s, "connected", CONN_T0 + 3000);
		expect(s.disconnectedSince).toBeNull();
	});

	it("stamps a drop that surfaces as a bare connecting event", () => {
		let s = reduceConnection(initialReconnectState(), "connected", CONN_T0);
		s = reduceConnection(s, "connecting", CONN_T0 + 40);
		expect(s.disconnectedSince).toBe(CONN_T0 + 40);
	});
});

// ============================================
// Reconnect-banner grace period
// ============================================

describe("hasOutlastedBannerGrace", () => {
	it("is false for a drop still inside the grace window", () => {
		expect(
			hasOutlastedBannerGrace(CONN_T0, CONN_T0 + RECONNECT_BANNER_GRACE_MS - 1),
		).toBe(false);
	});

	it("is true exactly at the grace boundary", () => {
		expect(
			hasOutlastedBannerGrace(CONN_T0, CONN_T0 + RECONNECT_BANNER_GRACE_MS),
		).toBe(true);
	});

	it("fails closed when no disconnect has been stamped", () => {
		expect(
			hasOutlastedBannerGrace(null, CONN_T0 + 10 * RECONNECT_BANNER_GRACE_MS),
		).toBe(false);
	});
});

describe("shouldRunBannerGraceClock", () => {
	it("never runs while connected", () => {
		expect(shouldRunBannerGraceClock(null, CONN_T0)).toBe(false);
	});

	it("runs while the drop is inside the grace window", () => {
		expect(shouldRunBannerGraceClock(CONN_T0, CONN_T0)).toBe(true);
		expect(
			shouldRunBannerGraceClock(
				CONN_T0,
				CONN_T0 + RECONNECT_BANNER_GRACE_MS - 1,
			),
		).toBe(true);
	});

	it("stops once the grace window has elapsed", () => {
		expect(
			shouldRunBannerGraceClock(CONN_T0, CONN_T0 + RECONNECT_BANNER_GRACE_MS),
		).toBe(false);
	});
});

describe("browser-offline grace input", () => {
	it("stamps the browser-offline edge once and clears it on recovery", () => {
		// Given no active browser-offline stamp.
		let stamp: number | null = null;

		// When repeated offline events arrive, followed by online recovery.
		stamp = reduceBrowserOfflineSince(stamp, false, CONN_T0);
		stamp = reduceBrowserOfflineSince(stamp, false, CONN_T0 + 1000);
		expect(stamp).toBe(CONN_T0);
		stamp = reduceBrowserOfflineSince(stamp, true, CONN_T0 + 2000);

		// Then the original drop time was stable and recovery clears it.
		expect(stamp).toBeNull();
	});

	it("uses the earliest browser-or-socket loss as the shared grace origin", () => {
		// Given browser network loss precedes the WebSocket close event.
		const browserOfflineSince = CONN_T0;
		const socketDisconnectedSince = CONN_T0 + 500;

		// When the shared grace origin is selected.
		const stamp = effectiveDisconnectedSince(
			socketDisconnectedSince,
			browserOfflineSince,
		);

		// Then browser loss starts the one grace window; no second timer is created.
		expect(stamp).toBe(browserOfflineSince);
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
	disconnectedSince: null,
};

const droppedInput = {
	...baseInput,
	isConnected: false,
	connectionState: "disconnected" as const,
	disconnectedSince: CONN_T0,
};
const AFTER_GRACE = CONN_T0 + RECONNECT_BANNER_GRACE_MS;

describe("deriveConnectionUx", () => {
	it("shows nothing while connected", () => {
		expect(deriveConnectionUx(baseInput, CONN_T0)).toEqual({
			mode: "connected",
			showBanner: false,
		});
	});

	it("shows the reconnecting banner when WS is down but the browser is online", () => {
		const ux = deriveConnectionUx(droppedInput, AFTER_GRACE);
		expect(ux).toEqual({ mode: "reconnecting", showBanner: true });
	});

	it("escalates to a hard failure once the retry budget is exhausted", () => {
		const ux = deriveConnectionUx(
			{ ...droppedInput, reconnectAttempts: MAX_RECONNECT_ATTEMPTS },
			AFTER_GRACE,
		);
		expect(ux).toEqual({ mode: "failed", showBanner: true });
	});

	it("shows the rebooting treatment even before the socket actually drops", () => {
		const ux = deriveConnectionUx({ ...baseInput, rebooting: true }, CONN_T0);
		expect(ux).toEqual({ mode: "rebooting", showBanner: true });
	});

	it("keeps the rebooting treatment while disconnected after a reboot", () => {
		const ux = deriveConnectionUx(
			{
				...droppedInput,
				rebooting: true,
				reconnectAttempts: MAX_RECONNECT_ATTEMPTS, // would otherwise be "failed"
			},
			AFTER_GRACE,
		);
		expect(ux).toEqual({ mode: "rebooting", showBanner: true });
	});

	it("defers to the browser-offline page (never doubles up the banner)", () => {
		const ux = deriveConnectionUx(
			{ ...droppedInput, showOfflinePage: true },
			AFTER_GRACE,
		);
		expect(ux.showBanner).toBe(false);
	});

	it("suppresses the banner when the browser itself went offline", () => {
		const ux = deriveConnectionUx(
			{ ...droppedInput, browserOnline: false },
			AFTER_GRACE,
		);
		expect(ux.showBanner).toBe(false);
	});

	it("stays silent through a drop that heals inside the grace window", () => {
		for (const elapsed of [0, 1, 500, RECONNECT_BANNER_GRACE_MS - 1]) {
			expect(deriveConnectionUx(droppedInput, CONN_T0 + elapsed)).toEqual({
				mode: "reconnecting",
				showBanner: false,
			});
		}
	});

	it("surfaces the banner once the drop outlasts the grace window", () => {
		expect(deriveConnectionUx(droppedInput, AFTER_GRACE)).toEqual({
			mode: "reconnecting",
			showBanner: true,
		});
		expect(deriveConnectionUx(droppedInput, AFTER_GRACE + 60_000)).toEqual({
			mode: "reconnecting",
			showBanner: true,
		});
	});

	it("never debounces the rebooting or failed treatments", () => {
		expect(
			deriveConnectionUx({ ...droppedInput, rebooting: true }, CONN_T0),
		).toEqual({ mode: "rebooting", showBanner: true });
		expect(
			deriveConnectionUx(
				{ ...droppedInput, reconnectAttempts: MAX_RECONNECT_ATTEMPTS },
				CONN_T0,
			),
		).toEqual({ mode: "failed", showBanner: true });
	});
});

describe("deriveConnectionSurfaceUx", () => {
	it("keeps every pre-auth interruption surface silent inside the shared grace window", () => {
		// Given a stalled saved-session check during a fresh socket drop.
		const input = {
			authTimedOut: true,
			disconnectedSince: CONN_T0,
		};

		// When the drop heals before the shared reconnect grace elapses.
		const ux = deriveConnectionSurfaceUx(
			input,
			CONN_T0 + RECONNECT_BANNER_GRACE_MS - 1,
		);

		// Then neither loud pre-auth surface is eligible to render.
		expect(ux).toEqual({
			showOfflineBanner: false,
			showAuthTimeout: false,
		});
	});

	it("surfaces every existing pre-auth interruption treatment after the shared grace", () => {
		// Given the same stalled saved-session check and a sustained socket drop.
		const input = {
			authTimedOut: true,
			disconnectedSince: CONN_T0,
		};

		// When the shared reconnect grace has elapsed.
		const ux = deriveConnectionSurfaceUx(
			input,
			CONN_T0 + RECONNECT_BANNER_GRACE_MS,
		);

		// Then the existing top banner and auth card remain available.
		expect(ux).toEqual({
			showOfflineBanner: true,
			showAuthTimeout: true,
		});
	});

	it("keeps an auth-only timeout visible when the socket is not in a drop", () => {
		// Given an auth request that stalled while transport stayed connected.
		const input = { authTimedOut: true, disconnectedSince: null };

		// When the auth timeout expires independently of connection loss.
		const ux = deriveConnectionSurfaceUx(input, CONN_T0);

		// Then only the existing auth recovery card appears.
		expect(ux).toEqual({
			showOfflineBanner: false,
			showAuthTimeout: true,
		});
	});

	it("projects ONE connection-loss signal, not a banner AND a toast", () => {
		// Given a sustained drop, i.e. every loss surface is eligible.
		const ux = deriveConnectionSurfaceUx(
			{ authTimedOut: false, disconnectedSince: CONN_T0 },
			CONN_T0 + RECONNECT_BANNER_GRACE_MS,
		);

		// Then the projection carries no second field for the same fact. The
		// retired `showConnectionLostToast` was byte-identically `showOfflineBanner`
		// and `PWAStatus` renders that banner unconditionally, so the toast could
		// never say anything the banner was not already saying. Re-adding a field
		// here must be a deliberate act, not an accident.
		expect(Object.keys(ux).sort()).toEqual([
			"showAuthTimeout",
			"showOfflineBanner",
		]);
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
		let s = reduceConnection(initialReconnectState(), "connecting", CONN_T0);
		s = reduceConnection(s, "connected", CONN_T0 + 1);
		const wasAuthed = true; // markAuthenticated() ran on the first success
		s = reduceConnection(s, "disconnected", CONN_T0 + 2);
		s = reduceConnection(s, "connecting", CONN_T0 + 3);
		s = reduceConnection(s, "connected", CONN_T0 + 4); // socket back, but auth re-sent
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
		netif: undefined,
		sensors: { "SoC temperature": "50.0°C" },
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

const T0 = 1_000_000;

describe("HUD staleness on WS disconnect", () => {
	it("marks isFullyStale once STALE_THRESHOLD_MS elapses after the drop", () => {
		const sources = makeSources({
			isConnected: false,
			connectionState: "disconnected",
		});
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const justAfter = deriveHudState(
			sources,
			timestamps,
			T0 + STALE_THRESHOLD_MS + 1,
		);
		expect(justAfter.isConnected).toBe(false);
		expect(justAfter.isFullyStale).toBe(true);
		// Fields dim but last-known values are preserved (not blanked).
		expect(justAfter.bitrateKbps).toBe(6000);
		expect(justAfter.temperature).toBe(50);
	});

	it("is not yet fully stale within the grace window after the drop", () => {
		const sources = makeSources({
			isConnected: false,
			connectionState: "disconnected",
		});
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const withinGrace = deriveHudState(
			sources,
			timestamps,
			T0 + STALE_THRESHOLD_MS - 1,
		);
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
