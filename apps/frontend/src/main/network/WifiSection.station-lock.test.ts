// @vitest-environment jsdom
/**
 * WifiSection — a radio mid-transition withholds its STATION controls, with the
 * reason on screen, and always gives them back (F-09).
 *
 * A hotspot start/stop and todo 7's per-adapter mode change both hold the
 * adapter's own lock for the whole NetworkManager activation, so a station
 * mutation dispatched into that window is refused `DEVICE_BUSY` by the device.
 * Leaving Connect live there is an affordance that provably cannot act — the
 * operator taps it, waits, and gets a failure toast for something the UI already
 * knew was impossible.
 *
 * House rule: NEVER HIDE, ALWAYS REASON. The control stays exactly where it was,
 * disabled, and the reason is rendered ON SCREEN rather than only in a `title` —
 * the shipped kiosk touchscreen cannot hover.
 *
 * The store is warmed with `initAsyncOperations()` BEFORE the render (the
 * documented lifecycle): created lazily inside a component's derive, its
 * reactive root is detached and later external transitions never reach the
 * component — the trap todo 3 hit.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	beginOperation,
	clearOperation,
	destroyAsyncOperations,
	failOperation,
	initAsyncOperations,
	timeoutOperation,
} from "$lib/rpc/async-operation.svelte";

import WifiSection from "./WifiSection.svelte";
import { wifiHotspotOpKey, wifiModeOpKey } from "./wifi-station-lock";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		wifi: { hotspotStart: vi.fn(), hotspotStop: vi.fn() },
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const DEVICE = "wifi0";
const HOTSPOT_KEY = wifiHotspotOpKey(DEVICE);
const MODE_KEY = wifiModeOpKey(DEVICE);

function wifiIface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "uuid-mynet",
		hw: "hw0",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		supports_hotspot: true,
		...overrides,
	} as WifiInterface;
}

function renderSection(iface: Partial<WifiInterface> = {}) {
	const netif: NetifMessage = {
		wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
	} as unknown as NetifMessage;
	return render(WifiSection, {
		props: {
			wifiRadios: [[DEVICE, wifiIface(iface)]],
			netif,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry: vi.fn(),
		},
	});
}

function connectButton(): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(
		'[data-testid="open-wifi-selector-dialog"]',
	);
	if (!button) throw new Error("the station Connect control is not rendered");
	return button;
}

function bondSwitch(): HTMLElement {
	const control = document.querySelector<HTMLElement>(
		'[data-testid="bond-toggle-wlan0"]',
	);
	if (!control) throw new Error("the bond toggle is not rendered");
	return control;
}

beforeEach(() => {
	initAsyncOperations();
	clearOperation(HOTSPOT_KEY);
	clearOperation(MODE_KEY);
});

afterEach(() => {
	clearOperation(HOTSPOT_KEY);
	clearOperation(MODE_KEY);
	destroyAsyncOperations();
	vi.clearAllMocks();
});

describe("WifiSection — station controls during a pending adapter transition", () => {
	it("leaves the station controls live when nothing holds the adapter", () => {
		const { queryByTestId } = renderSection();

		expect(connectButton().disabled).toBe(false);
		expect(queryByTestId("wifi-station-locked")).toBeNull();
		expect(queryByTestId("wifi-station-lock-failed")).toBeNull();
	});

	it("disables Connect WITH A VISIBLE REASON while a hotspot change is pending", async () => {
		const { getByTestId } = renderSection();
		expect(connectButton().disabled).toBe(false);

		beginOperation(HOTSPOT_KEY, "hotspot");
		await tick();

		// Still rendered — never hidden — and refusing input.
		const connect = connectButton();
		expect(connect.disabled).toBe(true);
		expect(connect.dataset.locked).toBe("true");

		// …and the reason is ON SCREEN, not only in the tooltip a touchscreen
		// operator can never reveal.
		const band = getByTestId("wifi-station-locked");
		expect(band.dataset.lockKind).toBe("hotspot");
		expect(band.textContent?.trim().length ?? 0).toBeGreaterThan(0);
		expect(band.textContent).toBe(connect.getAttribute("title"));
	});

	it("disables Connect for todo 7's `wifi-mode` transition too, naming that op", async () => {
		const { getByTestId } = renderSection();

		beginOperation(MODE_KEY, "hybrid");
		await tick();

		expect(connectButton().disabled).toBe(true);
		const band = getByTestId("wifi-station-locked");
		expect(band.dataset.lockKind).toBe("mode");
	});

	it("withholds the bond toggle under the same reason", async () => {
		renderSection();
		expect(bondSwitch().hasAttribute("disabled")).toBe(false);

		beginOperation(HOTSPOT_KEY, "hotspot");
		await tick();

		const toggle = bondSwitch();
		expect(toggle.hasAttribute("disabled")).toBe(true);
		expect(toggle.getAttribute("aria-label")).toBe(
			document.querySelector('[data-testid="wifi-station-locked"]')
				?.textContent,
		);
	});

	it("re-enables Connect on a terminal FAILURE and renders what went wrong", async () => {
		const { getByTestId, queryByTestId } = renderSection();

		beginOperation(HOTSPOT_KEY, "hotspot");
		await tick();
		expect(connectButton().disabled).toBe(true);

		// The device's own terminal frame refuses the transition.
		failOperation(HOTSPOT_KEY, "activation-failed");
		await tick();

		// NO ETERNAL DISABLE: the controls come back the moment the op settles.
		const connect = connectButton();
		expect(connect.disabled).toBe(false);
		expect(connect.dataset.locked).toBeUndefined();
		expect(bondSwitch().hasAttribute("disabled")).toBe(false);
		expect(queryByTestId("wifi-station-locked")).toBeNull();

		// …and the failure is stated rather than swallowed.
		const failure = getByTestId("wifi-station-lock-failed");
		expect(failure.dataset.failureKind).toBe("hotspot");
		expect(failure.textContent?.trim().length ?? 0).toBeGreaterThan(0);
	});

	it("re-enables Connect when the device never answers, and says so distinctly", async () => {
		const { getByTestId } = renderSection();

		beginOperation(MODE_KEY, "hotspot");
		await tick();
		expect(connectButton().disabled).toBe(true);

		// No terminal frame ever arrives; the store's TTL valve fires instead.
		timeoutOperation(MODE_KEY);
		await tick();

		expect(connectButton().disabled).toBe(false);
		const failure = getByTestId("wifi-station-lock-failed");
		expect(failure.dataset.failureKind).toBe("mode");

		// A refusal and a result that never arrived are different facts, so they
		// must not read as the same sentence.
		const unconfirmedCopy = failure.textContent;
		clearOperation(MODE_KEY);
		beginOperation(MODE_KEY, "hotspot");
		await tick();
		failOperation(MODE_KEY, "activation-failed");
		await tick();
		expect(getByTestId("wifi-station-lock-failed").textContent).not.toBe(
			unconfirmedCopy,
		);
	});

	it("names the MODE change when a mode transition drives the hotspot leg", async () => {
		const { getByTestId } = renderSection();

		// `setWifiAdapterMode` delegates to the hotspot transaction, so one operator
		// action legitimately holds both keys.
		beginOperation(MODE_KEY, "hybrid");
		beginOperation(HOTSPOT_KEY, "hotspot");
		await tick();

		expect(getByTestId("wifi-station-locked").dataset.lockKind).toBe("mode");
	});
});
