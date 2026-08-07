/**
 * Reconnect smoke — the DisconnectedBanner + connection-ux reconnect cycle.
 *
 * Substitutes for the Playwright reconnect e2e: chromium cannot launch in this
 * sandbox (SIGTRAP on the headless-shell process — a pre-existing environment
 * limitation, not a code defect). Instead this drives the REAL connection-ux
 * reactive store (`reduceConnection`) through a mocked transport-level
 * `rpcClient.onConnectionChange`, then feeds its live selectors into the REAL
 * `deriveConnectionUx` exactly as `DisconnectedBanner.svelte` wires them.
 *
 * Proves the full loop the e2e would: a good connect, socket drop → reconnecting
 * banner shows, budget escalates to the failed banner, a manual retry re-dials
 * the transport and rehydrates the budget, and a successful reconnect resets the
 * reconnect budget to zero exactly once (state rehydrates once, no double-count).
 *
 * It also covers the reconnect-banner grace period: a drop that heals inside
 * `RECONNECT_BANNER_GRACE_MS` is silent, and the self-gating grace clock runs
 * only for the length of that window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";
import type { ConnectionUx } from "$lib/stores/connection-ux.svelte";

let capturedHandler: ((state: ConnectionState) => void) | null = null;
let connectCalls = 0;

vi.mock("$lib/rpc/client", () => ({
	rpcClient: {
		onConnectionChange: (handler: (state: ConnectionState) => void) => {
			capturedHandler = handler;
			return () => {
				capturedHandler = null;
			};
		},
		getConnectionState: (): ConnectionState => "connecting",
		connect: () => {
			connectCalls += 1;
		},
	},
}));

type ConnUxModule = typeof import("$lib/stores/connection-ux.svelte");

async function loadConnUx(): Promise<ConnUxModule> {
	vi.resetModules();
	capturedHandler = null;
	connectCalls = 0;
	const mod = await import("$lib/stores/connection-ux.svelte");
	// In the node vitest env `window` is undefined, so the connection-ux singleton
	// is created lazily on first selector access. Touch a getter to instantiate it
	// — that construction is what registers the `onConnectionChange` handler.
	mod.getReconnectAttempts();
	return mod;
}

/**
 * Mirror `DisconnectedBanner.svelte`'s derivation wiring: `isConnected` tracks the
 * socket the same way `subscriptions.svelte` does (a "connected" transition → true,
 * anything else → false), while `reconnectAttempts` / `rebooting` /
 * `disconnectedSince` come from the live connection-ux selectors.
 *
 * `disconnectedForMs` stands in for the grace clock the reactive store runs in the
 * browser: it offsets `now` from the store's own disconnect stamp, and defaults
 * past the grace period so a caller asking "what does the banner look like during
 * this drop" gets the settled answer rather than the first-instant one.
 */
function bannerFor(
	mod: ConnUxModule,
	isConnected: boolean,
	opts: {
		browserOnline?: boolean;
		showOfflinePage?: boolean;
		disconnectedForMs?: number;
	} = {},
): ConnectionUx {
	const {
		browserOnline = true,
		showOfflinePage = false,
		disconnectedForMs = mod.RECONNECT_BANNER_GRACE_MS,
	} = opts;
	const disconnectedSince = mod.getDisconnectedSince();
	return mod.deriveConnectionUx(
		{
			isConnected,
			connectionState: isConnected ? "connected" : "disconnected",
			browserOnline,
			showOfflinePage,
			reconnectAttempts: mod.getReconnectAttempts(),
			rebooting: mod.getIsRebooting(),
			disconnectedSince,
		},
		(disconnectedSince ?? Date.now()) + disconnectedForMs,
	);
}

beforeEach(() => {
	capturedHandler = null;
	connectCalls = 0;
});

describe("reconnect smoke: DisconnectedBanner ↔ connection-ux", () => {
	it("registers exactly one transport-level connection handler", async () => {
		await loadConnUx();
		expect(capturedHandler).toBeTypeOf("function");
	});

	it("drop → reconnecting banner → reconnect hides it and rehydrates the budget once", async () => {
		const mod = await loadConnUx();

		// Initial good connection: no banner.
		capturedHandler?.("connected");
		expect(mod.getReconnectAttempts()).toBe(0);
		let banner = bannerFor(mod, true);
		expect(banner).toEqual({ mode: "connected", showBanner: false });

		// Socket drops — the raw drop itself does not yet count as a retry.
		capturedHandler?.("disconnected");
		expect(mod.getReconnectAttempts()).toBe(0);

		// The transport begins a reconnect attempt → banner shows "reconnecting".
		capturedHandler?.("connecting");
		expect(mod.getReconnectAttempts()).toBe(1);
		banner = bannerFor(mod, false);
		expect(banner).toEqual({ mode: "reconnecting", showBanner: true });

		// Reconnect succeeds → budget rehydrates to zero exactly once, banner hides.
		capturedHandler?.("connected");
		expect(mod.getReconnectAttempts()).toBe(0);
		banner = bannerFor(mod, true);
		expect(banner).toEqual({ mode: "connected", showBanner: false });
	});

	it("escalates to the failed banner after the budget is exhausted; manual retry re-dials + rehydrates", async () => {
		const mod = await loadConnUx();

		capturedHandler?.("connected");
		// Exhaust the UI reconnect budget (MAX_RECONNECT_ATTEMPTS = 5).
		for (let i = 0; i < mod.MAX_RECONNECT_ATTEMPTS; i += 1) {
			capturedHandler?.("connecting");
		}
		expect(mod.getReconnectAttempts()).toBe(mod.MAX_RECONNECT_ATTEMPTS);
		expect(bannerFor(mod, false)).toEqual({ mode: "failed", showBanner: true });

		// Manual "retry now" re-dials the transport and resets the local budget.
		mod.retryConnection();
		expect(connectCalls).toBe(1);
		expect(mod.getReconnectAttempts()).toBe(0);
		expect(bannerFor(mod, false)).toEqual({
			mode: "reconnecting",
			showBanner: true,
		});

		// And a successful reconnect returns to the calm connected state.
		capturedHandler?.("connected");
		expect(bannerFor(mod, true)).toEqual({
			mode: "connected",
			showBanner: false,
		});
	});

	it("stays silent through a drop that heals inside the grace window", async () => {
		const mod = await loadConnUx();
		capturedHandler?.("connected");

		// The whole heartbeat-triggered re-dial cycle, start to finish, inside the
		// grace window: the operator must see nothing at any point in it.
		capturedHandler?.("disconnected");
		expect(bannerFor(mod, false, { disconnectedForMs: 0 })).toEqual({
			mode: "reconnecting",
			showBanner: false,
		});

		capturedHandler?.("connecting");
		expect(
			bannerFor(mod, false, {
				disconnectedForMs: mod.RECONNECT_BANNER_GRACE_MS - 1,
			}),
		).toEqual({ mode: "reconnecting", showBanner: false });

		capturedHandler?.("connected");
		expect(mod.getDisconnectedSince()).toBeNull();
		expect(bannerFor(mod, true)).toEqual({
			mode: "connected",
			showBanner: false,
		});
	});

	it("runs the grace clock only for the length of the grace window", async () => {
		vi.useFakeTimers();
		try {
			const mod = await loadConnUx();
			capturedHandler?.("connected");
			expect(mod.isGraceClockRunning()).toBe(false);

			capturedHandler?.("disconnected");
			expect(mod.isGraceClockRunning()).toBe(true);

			// The clock exists solely to advance `now` past the grace, then stop —
			// a drop fires no further events, so nothing else could re-derive.
			vi.advanceTimersByTime(
				mod.RECONNECT_BANNER_GRACE_MS + mod.RECONNECT_BANNER_TICK_MS,
			);
			expect(mod.isGraceClockRunning()).toBe(false);
			expect(
				mod.getGraceNow() - (mod.getDisconnectedSince() ?? 0),
			).toBeGreaterThanOrEqual(mod.RECONNECT_BANNER_GRACE_MS);

			capturedHandler?.("connected");
			expect(mod.isGraceClockRunning()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds the rebooting treatment across the drop and clears the latch on reconnect", async () => {
		const mod = await loadConnUx();
		capturedHandler?.("connected");

		// A reboot is triggered: the latch shows the rebooting banner even before
		// the socket actually drops.
		mod.markRebooting();
		expect(bannerFor(mod, true)).toEqual({
			mode: "rebooting",
			showBanner: true,
		});

		// The device goes down and starts coming back — still rebooting.
		capturedHandler?.("disconnected");
		capturedHandler?.("connecting");
		expect(bannerFor(mod, false)).toEqual({
			mode: "rebooting",
			showBanner: true,
		});

		// Device is back: reduceConnection clears the reboot latch on "connected".
		capturedHandler?.("connected");
		expect(mod.getIsRebooting()).toBe(false);
		expect(bannerFor(mod, true)).toEqual({
			mode: "connected",
			showBanner: false,
		});
	});
});
