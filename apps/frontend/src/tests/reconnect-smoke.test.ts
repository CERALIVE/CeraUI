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
 * anything else → false), while `reconnectAttempts` / `rebooting` come from the
 * live connection-ux selectors.
 */
function bannerFor(
	mod: ConnUxModule,
	isConnected: boolean,
	opts: { browserOnline?: boolean; showOfflinePage?: boolean } = {},
): ConnectionUx {
	const { browserOnline = true, showOfflinePage = false } = opts;
	return mod.deriveConnectionUx({
		isConnected,
		connectionState: isConnected ? "connected" : "disconnected",
		browserOnline,
		showOfflinePage,
		reconnectAttempts: mod.getReconnectAttempts(),
		rebooting: mod.getIsRebooting(),
	});
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
