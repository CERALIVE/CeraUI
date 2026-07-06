// @vitest-environment jsdom
/**
 * WifiSection — single-line rows + telemetry dedupe + 44px touch targets (T20).
 *
 * T19 made `BondedLinksSection` the SOLE home of live per-link numbers on the
 * Network page, so this section no longer renders a `LinkIndicator`, a signal-%
 * readout, or a speed `Badge` (all carried `data-live-value`). The identity and
 * control rows are merged into ONE flex line (`py-2.5`, no `.mt-2.5` row) and the
 * row action buttons carry the tokenized touch-target min-height so they lift to
 * 44px under `data-layout-mode="touch"` (WCAG 2.5.5).
 *
 * KEEP invariants asserted here: the stale `Badge`, the `disabledReason` bond
 * toggle, and the section still renders per radio.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
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

const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";

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

function renderSection(
	opts: {
		iface?: Partial<WifiInterface>;
		netif?: NetifMessage;
		stale?: Set<string>;
	} = {},
) {
	const iface = wifiIface(opts.iface);
	return render(WifiSection, {
		props: {
			wifiRadios: [["wifi0", iface]],
			netif: opts.netif ?? {
				wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
			},
			isFullyStale: false,
			staleInterfaces: opts.stale ?? new Set<string>(),
			onConnect: vi.fn(),
		},
	});
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("WifiSection — T20 single-line rows + touch targets", () => {
	it("renders NO per-row telemetry (no LinkIndicator / signal% / speed Badge)", () => {
		const { container } = renderSection();
		// The signal-% span AND the speed Badge both carried data-live-value.
		expect(container.querySelectorAll("[data-live-value]").length).toBe(0);
	});

	it("merges identity + controls into ONE row (py-2.5, no .mt-2.5 control row)", () => {
		const { container } = renderSection();
		expect(container.querySelector(".mt-2\\.5")).toBeNull();
		// The interface row uses the new compact density.
		const row = container.querySelector(".divide-y > .py-2\\.5");
		expect(row, "compact py-2.5 interface row must render").not.toBeNull();
		// Old spacious density is gone from interface rows.
		expect(container.querySelector(".divide-y > .py-4")).toBeNull();
	});

	it("row action buttons carry the 44px touch-min class under data-layout-mode=touch", () => {
		document.documentElement.dataset.layoutMode = "touch";
		const { getByTestId } = renderSection();
		expect(getByTestId("open-wifi-selector-dialog").className).toContain(
			TOUCH_MIN_CLASS,
		);
	});

	it("KEEPS the stale Badge for an aged connected station", () => {
		const { container } = renderSection({ stale: new Set(["wlan0"]) });
		expect(
			container.querySelector('[data-stale-interface="wlan0"]'),
			"stale badge preserved",
		).not.toBeNull();
	});

	it("KEEPS the disabledReason bond toggle for a hotspot radio (cannot bond)", () => {
		const hotspot = {
			name: "AP",
			password: "password1",
			available_channels: {},
			channel: "auto",
		} as WifiInterface["hotspot"];
		const { container } = renderSection({
			iface: { hotspot, supports_hotspot: true },
		});
		expect(
			container.querySelector('[data-testid="bond-toggle-wlan0"]'),
		).not.toBeNull();
	});
});
