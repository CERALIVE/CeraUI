// @vitest-environment jsdom
/**
 * WifiSection — per-interface Connect (ceraui-refinement-pass Todo 1).
 *
 * Each station-mode radio owns its OWN "Connect" button that opens the WiFi
 * selector scoped to THAT radio's device id — replacing the single section-header
 * Connect button that could only ever target one primary radio.
 *
 * Invariants asserted here:
 *   (a) every station-mode row renders a per-row Connect button (data-device),
 *   (b) clicking row N's Connect calls onConnect(id) with THAT row's device id,
 *   (c) the section header no longer contains a Connect button.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import WifiSection from "./WifiSection.svelte";

// Isolate the child BondToggle from the live RPC client / socket.
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

function wifiIface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		supports_hotspot: false,
		...overrides,
	} as WifiInterface;
}

// Two station radios — one connected-with-IP, one disconnected-no-IP — proving
// the per-row Connect renders regardless of `hasIp`.
const RADIOS: [string, WifiInterface][] = [
	["wifi0", wifiIface({ ifname: "wlan0", conn: "MyNet" })],
	["wifi1", wifiIface({ ifname: "wlan1", conn: undefined, available: [] })],
];

function renderSection(onConnect = vi.fn()) {
	const netif: NetifMessage = {
		wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
		wlan1: { tp: 0, enabled: false },
	} as unknown as NetifMessage;
	return {
		onConnect,
		...render(WifiSection, {
			props: {
				wifiRadios: RADIOS,
				netif,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConnect,
			},
		}),
	};
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("WifiSection — per-interface Connect", () => {
	it("(a) renders a per-row Connect button for EVERY station radio (data-device)", () => {
		const { getAllByTestId } = renderSection();
		const buttons = getAllByTestId("open-wifi-selector-dialog");
		expect(buttons).toHaveLength(RADIOS.length);
		expect(buttons.map((b) => b.getAttribute("data-device")).sort()).toEqual([
			"wifi0",
			"wifi1",
		]);
	});

	it("(b) clicking a row's Connect calls onConnect with THAT row's device id", async () => {
		const { getAllByTestId, onConnect } = renderSection();
		const buttons = getAllByTestId("open-wifi-selector-dialog");
		const second = buttons.find(
			(b) => b.getAttribute("data-device") === "wifi1",
		);
		expect(second, "second row Connect button must exist").toBeTruthy();
		await fireEvent.click(second as HTMLElement);
		expect(onConnect).toHaveBeenCalledTimes(1);
		expect(onConnect).toHaveBeenCalledWith("wifi1");
	});

	it("(c) the section header contains NO Connect button", () => {
		const { container } = renderSection();
		const header = container.querySelector(".border-b");
		expect(header, "section header must render").not.toBeNull();
		expect(
			header?.querySelector("button"),
			"header must not contain any button",
		).toBeNull();
	});
});
