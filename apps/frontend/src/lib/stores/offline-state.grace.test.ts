// @vitest-environment jsdom
/**
 * The full-page offline takeover shares ONE debounced connection-loss signal.
 *
 * `offline-state.svelte`'s `handleOffline()` used to set the takeover flag
 * SYNCHRONOUSLY on the raw browser `offline` event — zero debounce — while every
 * smaller surface (the pre-auth top banner, the authenticated `DisconnectedBanner`)
 * correctly waited out `RECONNECT_BANNER_GRACE_MS`. So the loudest treatment in
 * the app was also the only undebounced one: a quiet-socket re-dial that heals in
 * under a second could throw the whole screen away.
 *
 * These drive the REAL stores end to end — the real `connection-ux` singleton
 * stamping the drop and running its real self-gating grace clock, the real
 * `offline-state` listeners — through a fan-out `onConnectionChange` mock that
 * models the transport's actual multi-subscriber contract. Nothing about the
 * grace is stubbed; only the clock is driven by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";

const T0 = 1_700_000_000_000;

let seedState: ConnectionState = "connecting";
let browserOnline = true;
const handlers = new Set<(state: ConnectionState) => void>();

vi.mock("$lib/rpc/client", () => ({
	rpcClient: {
		getConnectionState: () => seedState,
		onConnectionChange: (handler: (state: ConnectionState) => void) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		connect: () => undefined,
	},
}));

vi.mock("./pwa.svelte", () => ({ getIsOnline: () => browserOnline }));

type OfflineStateModule = typeof import("./offline-state.svelte");
type ConnUxModule = typeof import("./connection-ux.svelte");

let loaded: { mod: OfflineStateModule; connUx: ConnUxModule } | null = null;
let pollSpy: ReturnType<typeof vi.spyOn> | null = null;

/** Both stores subscribe to the one transport handler; fan out like it does. */
function emit(state: ConnectionState): void {
	seedState = state;
	for (const handler of [...handlers]) handler(state);
}

/** How many times the reload-capable recovery poll has been armed. */
function pollArmCount(): number {
	const cadence = loaded?.mod.PERIODIC_CHECK_INTERVAL;
	return (pollSpy?.mock.calls ?? []).filter((call) => call[1] === cadence)
		.length;
}

/** The one shared grace constant, read from its owning module. */
function graceMs(): number {
	const value = loaded?.connUx.RECONNECT_BANNER_GRACE_MS;
	if (value === undefined) throw new Error("connection-ux is not loaded");
	return value;
}

async function load(): Promise<OfflineStateModule> {
	vi.resetModules();
	handlers.clear();
	seedState = "connecting";
	browserOnline = true;
	const connUx = await import("./connection-ux.svelte");
	const mod = await import("./offline-state.svelte");
	loaded = { mod, connUx };
	pollSpy = vi.spyOn(window, "setInterval");
	return mod;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	// The initial-connectivity probe fetches the origin's favicon on import; an
	// unstubbed fetch would fail in jsdom and request the takeover for a reason
	// none of these cases is about.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	pollSpy?.mockRestore();
	pollSpy = null;
	loaded?.mod.cleanup();
	loaded?.connUx.destroyConnectionUxStore();
	loaded = null;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("deriveOfflinePageVisible", () => {
	it("shows nothing while nothing is asking", async () => {
		const { deriveOfflinePageVisible } = await load();

		expect(deriveOfflinePageVisible("none", true, T0, T0 + 60_000)).toBe(false);
		expect(deriveOfflinePageVisible("none", false, null, T0)).toBe(false);
	});

	it("never debounces an explicit immediate request", async () => {
		const { deriveOfflinePageVisible } = await load();

		expect(deriveOfflinePageVisible("immediate", true, T0, T0)).toBe(true);
	});

	it("keeps the first-load recovery page immediate when nothing ever connected", async () => {
		const { deriveOfflinePageVisible } = await load();

		// Given a page that has never completed a connection, there is no
		// transient drop to wait out — and no shared stamp need exist yet.
		expect(deriveOfflinePageVisible("debounced", false, null, T0)).toBe(true);
	});

	it("withholds an ordinary loss until the shared grace elapses", async () => {
		const { deriveOfflinePageVisible } = await load();

		for (const elapsed of [0, 1, 500, graceMs() - 1]) {
			expect(
				deriveOfflinePageVisible("debounced", true, T0, T0 + elapsed),
			).toBe(false);
		}
		expect(
			deriveOfflinePageVisible("debounced", true, T0, T0 + graceMs()),
		).toBe(true);
	});

	it("fails closed when no drop was ever stamped", async () => {
		const { deriveOfflinePageVisible } = await load();

		// A missing stamp must never be the reason a surface appears — the same
		// rule `hasOutlastedBannerGrace` already applies to the banner.
		expect(deriveOfflinePageVisible("debounced", true, null, T0 + 60_000)).toBe(
			false,
		);
	});
});

describe("the browser offline event joins the shared grace", () => {
	it("does not take the screen the instant the browser reports offline", async () => {
		const mod = await load();
		emit("connected");

		// When the browser fires its raw offline edge.
		browserOnline = false;
		window.dispatchEvent(new Event("offline"));

		// Then the takeover is withheld, and the reload-capable recovery poll has
		// not been armed either — this is the exact regression: both used to fire
		// synchronously in `handleOffline`.
		expect(mod.getOfflinePageRequest()).toBe("debounced");
		expect(mod.getShouldShowOfflinePage()).toBe(false);
		expect(pollArmCount()).toBe(0);
	});

	it("stays withheld for the whole grace window, then takes over", async () => {
		const mod = await load();
		emit("connected");

		browserOnline = false;
		window.dispatchEvent(new Event("offline"));

		await vi.advanceTimersByTimeAsync(graceMs() - 1);
		expect(mod.getShouldShowOfflinePage()).toBe(false);
		expect(pollArmCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(mod.getShouldShowOfflinePage()).toBe(true);
		expect(pollArmCount()).toBe(1);
	});

	it("is completely silent through a blip that heals inside the grace", async () => {
		const mod = await load();
		emit("connected");

		browserOnline = false;
		window.dispatchEvent(new Event("offline"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(mod.getShouldShowOfflinePage()).toBe(false);

		// When the browser comes back well inside the window.
		browserOnline = true;
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(600);

		// Then nothing is left behind: no takeover after the window would have
		// elapsed, and no poll was ever armed, so no PWA reload was spent.
		await vi.advanceTimersByTimeAsync(graceMs() + 1000);
		expect(mod.getOfflinePageRequest()).toBe("none");
		expect(mod.getShouldShowOfflinePage()).toBe(false);
		expect(pollArmCount()).toBe(0);
	});

	it("measures one outage from one origin when a socket drop follows the browser edge", async () => {
		const mod = await load();
		emit("connected");

		browserOnline = false;
		window.dispatchEvent(new Event("offline"));
		await vi.advanceTimersByTimeAsync(2000);

		// When the socket notices the same outage two seconds later.
		emit("disconnected");

		// Then the grace still runs out at the FIRST edge, not the second — a
		// second stamp would restart the window on every retry.
		await vi.advanceTimersByTimeAsync(1000);
		expect(mod.getShouldShowOfflinePage()).toBe(true);
	});
});

describe("a socket loss before the page ever connected", () => {
	it("takes the screen at once instead of arming nothing at all", async () => {
		const mod = await load();

		// Given the transport errors before any successful connection. This is the
		// old `threshold = 0` path, which scheduled NO timeout and then latched
		// `offlineStartTime`, so the takeover could never arrive for that outage.
		browserOnline = true;
		emit("error");

		expect(mod.getOfflinePageRequest()).toBe("debounced");
		expect(mod.getShouldShowOfflinePage()).toBe(true);
	});

	it("clears again the moment the transport comes up", async () => {
		const mod = await load();
		emit("error");
		expect(mod.getShouldShowOfflinePage()).toBe(true);

		emit("connected");
		expect(mod.getOfflinePageRequest()).toBe("none");
		expect(mod.getShouldShowOfflinePage()).toBe(false);
	});
});
