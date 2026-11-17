// @vitest-environment jsdom
/**
 * pwa-status.svelte against the REAL connection-ux store.
 *
 * The top band used to say "You're offline" for every connection loss, because
 * its visibility folds the browser's own offline state and a dropped device
 * socket into one timestamp. Those are different situations: with the browser
 * online, a dropped socket only means the device cannot be reached from here,
 * and the device may still be streaming. These cases drive the store through a
 * mocked transport and real `online`/`offline` window events, and check which
 * words the operator sees in each one:
 *
 *   · device unreachable on a working network → "Not connected to the device";
 *   · the browser itself offline → "You're offline";
 *   · recovery in both directions clears or re-words the band;
 *   · the auth-timeout card keeps its existing grace gating next to it.
 */
import { m } from "@ceraui/i18n/svelte";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";

// Hoisted: the store registers its transport handler at module load in jsdom.
const transport = vi.hoisted(() => ({
	handler: null as ((state: ConnectionState) => void) | null,
}));

vi.mock("$lib/rpc/client", () => ({
	rpcClient: {
		onConnectionChange: (handler: (state: ConnectionState) => void) => {
			transport.handler = handler;
			return () => {
				if (transport.handler === handler) transport.handler = null;
			};
		},
		getConnectionState: (): ConnectionState => "connecting",
		connect: () => {},
	},
}));

vi.mock("$lib/stores/pwa.svelte", () => ({
	getCanInstall: () => false,
	installApp: vi.fn(),
	setShowIOSInstallPrompt: vi.fn(),
}));

vi.mock("$lib/stores/notifications.svelte", () => ({ push: vi.fn() }));

import * as connUx from "$lib/stores/connection-ux.svelte";

import PwaStatus from "./pwa-status.svelte";

function mountWithRealStore(): void {
	// A fresh store per case, created OUTSIDE the component (as the browser does
	// at module load) so its runes are not owned by a component `$derived`.
	connUx.destroyConnectionUxStore();
	connUx.getReconnectAttempts();
	render(PwaStatus);
}

function socket(state: ConnectionState): void {
	transport.handler?.(state);
	flushSync();
}

function browser(event: "online" | "offline"): void {
	window.dispatchEvent(new Event(event));
	flushSync();
}

/** Let the shared reconnect grace elapse, as the store's own clock would. */
function outlastGrace(): void {
	vi.advanceTimersByTime(
		connUx.RECONNECT_BANNER_GRACE_MS + connUx.RECONNECT_BANNER_TICK_MS,
	);
	flushSync();
}

const youreOffline = () => screen.queryByText(m["pwa.offline"]());
const deviceNotConnected = () =>
	screen.queryByText(m["pwa.deviceNotConnected"]());
const tryingAgain = () =>
	screen.queryByText(m["pwa.deviceNotConnectedDescription"](), {
		exact: false,
	});

beforeEach(() => {
	vi.useFakeTimers();
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
});

afterEach(() => {
	connUx.destroyConnectionUxStore();
	vi.useRealTimers();
});

describe("pwa-status connection band, real store", () => {
	it("names the device, not the browser, when only the device socket drops", () => {
		mountWithRealStore();
		socket("connected");
		expect(deviceNotConnected()).toBeNull();
		expect(youreOffline()).toBeNull();

		socket("disconnected");
		socket("connecting");
		outlastGrace();

		expect(deviceNotConnected()).not.toBeNull();
		expect(tryingAgain()).not.toBeNull();
		expect(youreOffline()).toBeNull();
	});

	it("clears the band once the device answers again", () => {
		mountWithRealStore();
		socket("connected");
		socket("disconnected");
		outlastGrace();
		expect(deviceNotConnected()).not.toBeNull();

		socket("connected");

		expect(deviceNotConnected()).toBeNull();
		expect(youreOffline()).toBeNull();
	});

	it("says the browser is offline while the browser has no network", () => {
		mountWithRealStore();
		socket("connected");

		browser("offline");
		socket("disconnected");
		outlastGrace();

		expect(youreOffline()).not.toBeNull();
		expect(deviceNotConnected()).toBeNull();
	});

	it("re-words, then clears, as the browser and then the device come back", () => {
		mountWithRealStore();
		socket("connected");
		browser("offline");
		socket("disconnected");
		outlastGrace();
		expect(youreOffline()).not.toBeNull();

		// The network is back but the socket has not reconnected yet: the
		// browser is no longer offline, the device is simply not reached yet.
		browser("online");
		expect(youreOffline()).toBeNull();
		expect(deviceNotConnected()).not.toBeNull();

		socket("connected");
		expect(deviceNotConnected()).toBeNull();
		expect(youreOffline()).toBeNull();
	});

	it("keeps the auth-timeout gating while the band names the device", () => {
		mountWithRealStore();
		// A saved-session check that never got a socket: the first dial failed.
		socket("connecting");
		socket("disconnected");

		const surfaceAt = (now: number) =>
			connUx.deriveConnectionSurfaceUx(
				{
					authTimedOut: true,
					disconnectedSince: connUx.getDisconnectedSince(),
				},
				now,
			);

		// Inside the grace window neither loud surface is eligible.
		expect(surfaceAt(connUx.getGraceNow()).showAuthTimeout).toBe(false);
		expect(deviceNotConnected()).toBeNull();

		outlastGrace();

		expect(surfaceAt(connUx.getGraceNow())).toEqual({
			showOfflineBanner: true,
			showAuthTimeout: true,
		});
		expect(deviceNotConnected()).not.toBeNull();
		expect(youreOffline()).toBeNull();

		// An auth-only stall on a live socket keeps the card and drops the band.
		socket("connected");
		expect(surfaceAt(connUx.getGraceNow())).toEqual({
			showOfflineBanner: false,
			showAuthTimeout: true,
		});
		expect(deviceNotConnected()).toBeNull();
	});
});
