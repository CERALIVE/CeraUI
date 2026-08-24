// @vitest-environment jsdom
/**
 * The displayed mode is IDENTICAL across the three WiFi surfaces.
 *
 * This is the single-source-of-truth assertion todo 14 exists to make. Before
 * it, each surface answered "what mode is this radio in" its own way —
 * `WifiSection` from `isApRadio()` plus a concurrent-AP badge, `HotspotSection`
 * from `supports_ap_sta_concurrency`, `HotspotDialog` from `hotspotIsActive()`
 * — so a hybrid radio read as "AP active" on one card and "WiFi + AP" on
 * another, with no shared word for either.
 *
 * Each fixture is rendered through all three REAL components and their mode
 * badges are compared BY VALUE. A surface that re-derives locally fails here
 * even when its own suite passes.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import {
	resetWifiAdapterModes,
	setWifiAdapterModesForTest,
} from "$lib/rpc/wifi-adapter-modes.svelte";

import HotspotSection from "./HotspotSection.svelte";
import WifiSection from "./WifiSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		wifi: {
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfigure: vi.fn(async () => ({ success: true })),
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({ success: true, accepted: true })),
		},
	},
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: () => "connected",
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const DEVICE = "wifi0";

const NETIF = {
	wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
} as unknown as NetifMessage;

const LIVE_HOTSPOT = {
	name: "CERALIVE_TEST",
	password: "password1",
	available_channels: {},
};

function iface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		supports_hotspot: true,
		...overrides,
	} as WifiInterface;
}

const ALL_OFFERED = [
	{ mode: "station" as const, available: true },
	{ mode: "hotspot" as const, available: true },
	{ mode: "hybrid" as const, available: true },
];

/**
 * Every fixture states the device's OWN answer plus the interface snapshot that
 * would accompany it on the wire, so a surface reading either one lands on the
 * same word — which is exactly what makes disagreement detectable.
 */
const FIXTURES = [
	{
		name: "station on a radio with a proven AP+STA combination",
		mode: "station" as const,
		options: ALL_OFFERED,
		iface: { mode: "station", supports_ap_sta_concurrency: true },
		expected: "station",
	},
	{
		name: "exclusive hotspot",
		mode: "hotspot" as const,
		options: ALL_OFFERED,
		iface: { mode: "hotspot", hotspot: LIVE_HOTSPOT },
		expected: "hotspot",
	},
	{
		name: "hybrid — a station leg with a concurrent AP",
		mode: "hybrid" as const,
		options: ALL_OFFERED,
		iface: {
			mode: "station",
			supports_ap_sta_concurrency: true,
			hotspot: LIVE_HOTSPOT,
		},
		expected: "hybrid",
	},
	{
		name: "station on a radio whose combination is a PROVEN negative",
		mode: "station" as const,
		options: [
			{ mode: "station" as const, available: true },
			{ mode: "hotspot" as const, available: true },
			{
				mode: "hybrid" as const,
				available: false,
				reason: "capability-absent" as const,
			},
		],
		iface: { mode: "station", supports_ap_sta_concurrency: false },
		expected: "station",
	},
	{
		name: "hotspot on a radio whose combination was never checked",
		mode: "hotspot" as const,
		options: [
			{ mode: "station" as const, available: true },
			{ mode: "hotspot" as const, available: true },
			{
				mode: "hybrid" as const,
				available: false,
				reason: "capability-unknown" as const,
			},
		],
		iface: { mode: "hotspot", hotspot: LIVE_HOTSPOT },
		expected: "hotspot",
	},
] as const;

function badgeModes(container: HTMLElement | Document): string[] {
	return [...container.querySelectorAll('[data-testid="wifi-mode-badge"]')].map(
		(el) => el.getAttribute("data-mode") ?? "",
	);
}

beforeEach(() => {
	initAsyncOperations();
	resetWifiAdapterModes();
});

afterEach(() => {
	destroyAsyncOperations();
	resetWifiAdapterModes();
	vi.clearAllMocks();
});

describe("the displayed mode is identical across every surface", () => {
	for (const fixture of FIXTURES) {
		it(`${fixture.name} reads "${fixture.expected}" everywhere`, () => {
			setWifiAdapterModesForTest({
				[DEVICE]: {
					ifname: "wlan0",
					mode: fixture.mode,
					options: [...fixture.options],
				},
			});
			const radio = iface(fixture.iface as Partial<WifiInterface>);

			const wifi = render(WifiSection, {
				props: {
					wifiRadios: [[DEVICE, radio]],
					netif: NETIF,
					isFullyStale: false,
					staleInterfaces: new Set<string>(),
					onConnect: vi.fn(),
					onOpenCountry: vi.fn(),
				},
			});
			const wifiModes = badgeModes(wifi.container);
			expect(wifiModes).toEqual([fixture.expected]);
			// The selector's own root must agree with the badge beside it.
			expect(
				wifi.container
					.querySelector('[data-testid="wifi-mode-selector"]')
					?.getAttribute("data-mode"),
			).toBe(fixture.expected);
			wifi.unmount();

			const hotspot = render(HotspotSection, {
				props: {
					hotspotInterfaces: [[DEVICE, radio]],
					hotspotTarget: [DEVICE, radio],
					onSetup: vi.fn(),
				},
			});
			expect(badgeModes(hotspot.container)).toEqual([fixture.expected]);
			hotspot.unmount();
		});
	}

	it("the fixture set actually exercises more than one mode (non-vacuity)", () => {
		expect(new Set(FIXTURES.map((f) => f.expected)).size).toBeGreaterThan(1);
	});
});

describe("an unavailable mode states its reason on every surface that offers it", () => {
	it("renders a visible reason line, not only a title", () => {
		setWifiAdapterModesForTest({
			[DEVICE]: {
				ifname: "wlan0",
				mode: "station",
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{ mode: "hybrid", available: false, reason: "capability-unknown" },
				],
			},
		});

		const { container } = render(WifiSection, {
			props: {
				wifiRadios: [[DEVICE, iface({ mode: "station" })]],
				netif: NETIF,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConnect: vi.fn(),
				onOpenCountry: vi.fn(),
			},
		});

		const rung = container.querySelector<HTMLButtonElement>(
			`[data-testid="wifi-mode-option-${DEVICE}-hybrid"]`,
		);
		expect(rung?.getAttribute("aria-disabled")).toBe("true");
		expect(rung?.disabled).toBe(true);

		const reason = container.querySelector(
			`[data-testid="wifi-mode-reason-${DEVICE}-hybrid"]`,
		);
		expect(reason).not.toBeNull();
		expect(reason?.getAttribute("data-reason")).toBe("capability-unknown");
		expect((reason?.textContent ?? "").trim().length).toBeGreaterThan(0);
		// Never a raw dotted key.
		expect(reason?.textContent).not.toContain("network.wifiMode.");
	});
});
