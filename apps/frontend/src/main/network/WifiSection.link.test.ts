// @vitest-environment jsdom
/**
 * The connected row's live link line, rendered from the device's own
 * `iw dev <ifname> link` reading.
 *
 * The property that matters is that this line reports the CONNECTION, while the
 * capability strip above it reports the RADIO. They can differ — a Wi-Fi 7
 * adapter associated to an 802.11ac access point is running VHT right now — and
 * a row that reported the ceiling as the connection would be telling an
 * operator their link is faster than it is.
 *
 * The last describe is the regression lock: `link` is absent on an AP-mode
 * radio, on a disconnected station, on a read that failed its parser, and on
 * every backend that predates the field, so a row without one must render
 * EXACTLY what it rendered before this existed.
 */
import type {
	WifiAdapterCapabilities,
	WifiInterface,
	WifiLinkTelemetry,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import WifiSection from "./WifiSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			hotspotStart: vi.fn(),
			hotspotStop: vi.fn(),
			hotspotConfig: vi.fn(),
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
	getConfig: () => ({}),
	getWifi: () => ({}),
	getIsConnected: () => true,
}));

/** MT7925-class: a Wi-Fi 7 radio, so its ceiling can outrun any real link. */
const MT7925: WifiAdapterCapabilities = {
	phy: "phy0",
	generation: "wifi7",
	bands: ["2.4", "5", "6"],
	maxWidthMhz: { "2.4": 40, "5": 160, "6": 320 },
	apModes: ["2.4", "5", "6"],
	staApCombo: { supported: true, sameChannelOnly: false },
	wpa3Sae: "supported",
	regulatory: { country: "US", is6GhzLegal: true, self_managed: true },
};

const HE80: WifiLinkTelemetry = {
	generation: "wifi6",
	channelWidthMhz: 80,
	bitrateMbps: 573.5,
};

function radio(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "home-uuid",
		hw: "Realtek RTL8852BE",
		saved: {},
		available: [
			{
				active: true,
				ssid: "CERALIVE",
				signal: 72,
				security: "WPA2",
				freq: 5180,
			},
		],
		...overrides,
	} as WifiInterface;
}

function mount(radios: [string, WifiInterface][]) {
	return render(WifiSection, {
		props: {
			wifiRadios: radios,
			netif: { wlan0: { tp: 0, enabled: true, ip: "192.168.1.20" } },
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry: vi.fn(),
		},
	});
}

function lineText(el: HTMLElement): string {
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("WifiSection — the connected link line", () => {
	it("states the negotiated generation, width and rate on one line", () => {
		const { getByTestId } = mount([["0", radio({ link: HE80 })]]);

		const line = getByTestId("wifi-link-telemetry");
		expect(line.dataset.device).toBe("0");
		expect(line.dataset.generation).toBe("wifi6");
		// Whole megabits — `573.5` invites a precision the reading does not carry.
		expect(lineText(line)).toBe("Link Wi-Fi 6 · 80 MHz · 574 Mbit/s");
	});

	it("omits the width segment the device never measured", () => {
		const { getByTestId } = mount([
			["0", radio({ link: { generation: "wifi4", bitrateMbps: 65 } })],
		]);

		const line = getByTestId("wifi-link-telemetry");
		expect(line.dataset.widthMhz).toBeUndefined();
		expect(lineText(line)).toBe("Link Wi-Fi 4 · 65 Mbit/s");
		// One separator, not an orphan pair around a dropped segment.
		expect(lineText(line).match(/·/g)).toHaveLength(1);
	});

	it("reports the LINK, not the radio's ceiling, when the two differ", () => {
		const { getByTestId } = mount([
			[
				"0",
				radio({
					capabilities: MT7925,
					link: {
						generation: "wifi5",
						channelWidthMhz: 80,
						bitrateMbps: 433.3,
					},
				}),
			],
		]);

		expect(getByTestId("wifi-generation-badge").dataset.generation).toBe(
			"wifi7",
		);
		const line = getByTestId("wifi-link-telemetry");
		expect(line.dataset.generation).toBe("wifi5");
		expect(lineText(line)).toContain("Wi-Fi 5");
		expect(lineText(line)).not.toContain("Wi-Fi 7");
	});

	it("never renders on a hotspot radio, whatever the wire carries", () => {
		const { queryByTestId } = mount([
			[
				"0",
				radio({
					mode: "hotspot",
					hotspot: { available_channels: {} },
					link: HE80,
				}),
			],
		]);

		expect(queryByTestId("wifi-link-telemetry")).toBeNull();
	});
});

/**
 * The QA-failure lock. A disconnected station, a drifted read and an older
 * backend all send no `link`, so the row must be the row it always was.
 */
describe("WifiSection — a row with no link reading", () => {
	function normalize(el: Element): string {
		const clone = el.cloneNode(true) as Element;
		const walker = clone.ownerDocument.createTreeWalker(
			clone,
			NodeFilter.SHOW_COMMENT,
		);
		const comments: Node[] = [];
		while (walker.nextNode()) comments.push(walker.currentNode);
		for (const comment of comments) comment.parentNode?.removeChild(comment);
		return (
			clone.innerHTML
				// bits-ui mints element ids from a module-global counter, so two
				// renders in one file never agree on them. Everything else must.
				.replace(/bits-c\d+/g, "bits-c")
				.replace(/\s+/g, " ")
				.trim()
		);
	}

	it("renders no telemetry line at all", () => {
		const { queryByTestId, container } = mount([["0", radio()]]);

		expect(queryByTestId("wifi-link-telemetry")).toBeNull();
		expect(container.textContent).not.toContain("Mbit/s");
	});

	it("still renders the whole row — it is not an empty state", () => {
		const { container, getByTestId } = mount([["0", radio()]]);

		expect(container.textContent).toContain("wlan0");
		expect(container.textContent).toContain("CERALIVE");
		expect(getByTestId("open-wifi-selector-dialog").dataset.device).toBe("0");
	});

	it("is byte-identical to a linked row with its line removed", () => {
		const legacy = mount([["0", radio()]]);
		const linked = mount([["0", radio({ link: HE80 })]]);

		const linkedSection = linked.container.querySelector("section");
		linkedSection
			?.querySelector('[data-testid="wifi-link-telemetry"]')
			?.remove();

		expect(linkedSection).not.toBeNull();
		expect(normalize(linkedSection as Element)).toBe(
			normalize(legacy.container.querySelector("section") as Element),
		);
	});
});
