// @vitest-environment jsdom
/**
 * WifiSection — the per-adapter mode control.
 *
 * This file used to lock an ICON-ONLY "Switch to Hotspot" trigger plus a
 * separate concurrent-hotspot start button and "AP active" badge. Todo 14
 * replaced all three with ONE Station/Hotspot/Hybrid selector, so the icon-only
 * contract is gone by design — a mode rung's whole job is to carry its word.
 *
 * Every other guarantee that file encoded is preserved here, restated against
 * the control that replaced it:
 *   (a) the hotspot affordance is a button with an accessible name,
 *   (b) it carries a VISIBLE word (the deliberate inversion of the old
 *       icon-only rule — the shared mode vocabulary is the point),
 *   (c) it keeps the 44px touch-target min sizing token,
 *   (d) the in-flight state renders a spinner on the rung being switched to,
 *   (e) a PROVEN concurrent radio starts hybrid with no destructive confirm,
 *   (f) station controls stay visible while a concurrent hotspot is active.
 *
 * Todo 32 MOVED that selector behind the row's "Mode" popover, so every rung
 * assertion now opens it first (`openModeControl`) — the guarantees are the same
 * ones, asserted one tap further in. The popover is portalled to `document.body`
 * and the render result's queries are bound to `baseElement`, so they still
 * resolve; a `container`-scoped query would not.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearOperation,
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import {
	resetWifiAdapterModes,
	setWifiAdapterModesForTest,
} from "$lib/rpc/wifi-adapter-modes.svelte";

import WifiSection from "./WifiSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		wifi: {
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const HOTSPOT_RUNG = "Hotspot";
const HYBRID_RUNG = "Hybrid";
const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";

const ALL_MODES_OFFERED = {
	wifi0: {
		ifname: "wlan0",
		mode: "station" as const,
		options: [
			{ mode: "station" as const, available: true },
			{ mode: "hotspot" as const, available: true },
			{ mode: "hybrid" as const, available: true },
		],
	},
};

function wifiIface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		// Station mode + capable of hotspot → the hotspot rung is selectable.
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
			wifiRadios: [["wifi0", wifiIface(iface)]],
			netif,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry: vi.fn(),
		},
	});
}

/** Open the row's "Mode" popover — where the three-rung selector now lives. */
async function openModeControl(device = "wifi0"): Promise<void> {
	const trigger = document.querySelector<HTMLElement>(
		`[data-testid="open-wifi-mode"][data-device="${device}"]`,
	);
	if (!trigger) throw new Error("the Mode affordance is not rendered");
	await fireEvent.click(trigger);
	await tick();
}

beforeEach(() => {
	initAsyncOperations();
	resetWifiAdapterModes();
});

afterEach(() => {
	clearOperation("hotspot:wifi0");
	clearOperation("wifi-mode:wifi0");
	destroyAsyncOperations();
	resetWifiAdapterModes();
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("WifiSection — the adapter mode control", () => {
	it("(a) exposes the hotspot affordance as a named radio rung", async () => {
		const { getByRole } = renderSection();
		await openModeControl();
		expect(getByRole("radio", { name: HOTSPOT_RUNG })).toBeTruthy();
	});

	it("keeps the three rungs OUT of the row until the Mode affordance is opened", async () => {
		const { queryByTestId, getByTestId } = renderSection();

		// The mode still reads ONCE on the collapsed row — as the badge beside the
		// adapter's name — and the selector that used to restate it is not mounted.
		expect(getByTestId("wifi-mode-badge").dataset.mode).toBe("station");
		expect(queryByTestId("wifi-mode-selector")).toBeNull();
		expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);

		await openModeControl();
		expect(getByTestId("wifi-mode-selector").dataset.mode).toBe("station");
		expect(document.querySelectorAll('[role="radio"]').length).toBe(3);
	});

	it("(b) carries a VISIBLE word — the shared mode vocabulary, not an icon", async () => {
		const { getByRole } = renderSection();
		await openModeControl();
		const rung = getByRole("radio", { name: HOTSPOT_RUNG });
		expect(rung.textContent?.trim()).toBe(HOTSPOT_RUNG);
	});

	it("(c) keeps the 44px touch-target min sizing token", async () => {
		const { getByRole } = renderSection();
		await openModeControl();
		expect(getByRole("radio", { name: HOTSPOT_RUNG }).className).toContain(
			TOUCH_MIN_CLASS,
		);

		// …and so does the affordance that reveals it, since that is now the only
		// mode control a finger can reach on the row itself.
		expect(
			document.querySelector<HTMLElement>('[data-testid="open-wifi-mode"]')
				?.className,
		).toContain(TOUCH_MIN_CLASS);
	});

	it("(d) renders a spinner on the rung being switched to while in flight", async () => {
		setWifiAdapterModesForTest(ALL_MODES_OFFERED);
		const { getByRole, getByTestId } = renderSection({
			mode: "station",
			supports_ap_sta_concurrency: true,
		});
		await openModeControl();

		// Hybrid is additive (nothing is lost), so it dispatches without a confirm.
		await fireEvent.click(getByRole("radio", { name: HYBRID_RUNG }));
		await tick();
		await tick();

		expect(
			getByTestId("wifi-mode-option-wifi0-hybrid").querySelector("svg"),
		).not.toBeNull();
		expect(getByTestId("wifi-mode-pending-wifi0")).toBeTruthy();
	});
});

describe("WifiSection — AP+STA concurrent mode", () => {
	it("(e) starts a proven concurrent hotspot without a destructive confirm", async () => {
		setWifiAdapterModesForTest(ALL_MODES_OFFERED);
		const { getByRole, queryByTestId } = renderSection({
			mode: "station",
			supports_ap_sta_concurrency: true,
		});
		await openModeControl();

		await fireEvent.click(getByRole("radio", { name: HYBRID_RUNG }));
		await tick();

		expect(queryByTestId("wifi-mode-confirm-wifi0")).toBeNull();
		expect(rpc.wifi.setAdapterMode).toHaveBeenCalledWith({
			device: "wifi0",
			mode: "hybrid",
		});
	});

	it("(f) keeps station controls visible while the concurrent hotspot is active", async () => {
		setWifiAdapterModesForTest({
			wifi0: { ...ALL_MODES_OFFERED.wifi0, mode: "hybrid" },
		});
		const { getByRole, getByTestId } = renderSection({
			mode: "station",
			supports_ap_sta_concurrency: true,
			hotspot: {
				name: "CERALIVE_TEST",
				password: "password1",
				available_channels: {},
			},
		});

		expect(getByRole("button", { name: "Connect" })).toBeTruthy();
		expect(getByTestId("open-hotspot-setup")).toBeTruthy();
		// The row states the mode once, on the badge; the selector agrees with it.
		expect(getByTestId("wifi-mode-badge").dataset.mode).toBe("hybrid");
		await openModeControl();
		expect(getByTestId("wifi-mode-selector").getAttribute("data-mode")).toBe(
			"hybrid",
		);
	});
});

describe("WifiSection — a destructive transition is confirmed first", () => {
	it("arms an inline confirm naming the uplink loss and dispatches NOTHING", async () => {
		setWifiAdapterModesForTest(ALL_MODES_OFFERED);
		const { getByRole, getByTestId } = renderSection({
			mode: "station",
			supports_ap_sta_concurrency: true,
		});
		await openModeControl();

		await fireEvent.click(getByRole("radio", { name: HOTSPOT_RUNG }));
		await tick();

		const band = getByTestId("wifi-mode-confirm-wifi0");
		expect(band.getAttribute("data-consequence")).toBe("drops-uplink");
		expect(band.textContent).toContain("leaves the bond");
		expect(rpc.wifi.setAdapterMode).not.toHaveBeenCalled();

		await fireEvent.click(getByTestId("wifi-mode-confirm-apply-wifi0"));
		await tick();
		expect(rpc.wifi.setAdapterMode).toHaveBeenCalledWith({
			device: "wifi0",
			mode: "hotspot",
		});
	});

	it("cancelling the confirm leaves the prior mode and dispatches nothing", async () => {
		setWifiAdapterModesForTest(ALL_MODES_OFFERED);
		const { getByRole, getByTestId, queryByTestId } = renderSection({
			mode: "station",
			supports_ap_sta_concurrency: true,
		});
		await openModeControl();

		await fireEvent.click(getByRole("radio", { name: HOTSPOT_RUNG }));
		await tick();
		await fireEvent.click(getByTestId("wifi-mode-confirm-cancel-wifi0"));
		await tick();

		expect(queryByTestId("wifi-mode-confirm-wifi0")).toBeNull();
		expect(rpc.wifi.setAdapterMode).not.toHaveBeenCalled();
		expect(getByTestId("wifi-mode-selector").getAttribute("data-mode")).toBe(
			"station",
		);
	});
});
