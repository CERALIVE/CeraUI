// @vitest-environment jsdom
/**
 * The Wi-Fi row, rendered from the device's own capability report.
 *
 * Every assertion here is against the RENDERED DOM rather than the markup,
 * because the properties that matter are about what an operator can see: which
 * bands are offered, which generation is claimed, and whether a band the radio
 * carries but cannot use right now says so with a way out.
 *
 * The last describe is the regression lock. `capabilities` is optional on the
 * wire and absent on every backend that predates todo 2, so a row without one
 * must render EXACTLY what it rendered before this feature existed — proven by
 * comparing the two DOMs, not by spot-checking a few testids.
 */
import type {
	WifiAdapterCapabilities,
	WifiInterface,
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

/** Rock 5B+ / RTL8852BE — the shipped adapter, as todo 2's parser reads it. */
const ROCK_RTL8852BE: WifiAdapterCapabilities = {
	phy: "phy0",
	generation: "wifi6",
	bands: ["2.4", "5"],
	maxWidthMhz: { "2.4": 40, "5": 80 },
	apModes: ["2.4", "5"],
	staApCombo: { supported: true, sameChannelOnly: true },
	wpa3Sae: "supported",
	regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
};

/** MT7925-class — EHT, a real 6 GHz band, self-managed domain that allows it. */
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

function radio(capabilities?: WifiAdapterCapabilities): WifiInterface {
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
		...(capabilities ? { capabilities } : {}),
	} as WifiInterface;
}

function mount(
	radios: [string, WifiInterface][],
	onOpenCountry: () => void = vi.fn(),
) {
	return render(WifiSection, {
		props: {
			wifiRadios: radios,
			netif: { wlan0: { tp: 0, enabled: true, ip: "192.168.1.20" } },
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
			onOpenCountry,
		},
	});
}

function bandsOf(container: HTMLElement) {
	return [
		...container.querySelectorAll('[data-testid="wifi-band-option"]'),
	].map((el) => ({
		band: (el as HTMLElement).dataset.band,
		available: (el as HTMLElement).dataset.available,
		text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
	}));
}

describe("WifiSection — the shipped Wi-Fi 6 radio", () => {
	it("badges the generation from the wire and nothing else", () => {
		const { getByTestId } = mount([["0", radio(ROCK_RTL8852BE)]]);

		const badge = getByTestId("wifi-generation-badge");
		expect(badge.dataset.generation).toBe("wifi6");
		expect(badge.textContent?.trim()).toBe("Wi-Fi 6");
		// The RTL8852BE prints all-zero EHT structures; a UI that keyed on their
		// PRESENCE would claim Wi-Fi 7 for the adapter this fleet ships.
		expect(badge.textContent).not.toContain("Wi-Fi 7");
	});

	it("offers exactly the two bands it carries, each with its own width", () => {
		const { container } = mount([["0", radio(ROCK_RTL8852BE)]]);

		expect(bandsOf(container)).toEqual([
			{ band: "2.4", available: "true", text: "2.4 GHz 40 MHz" },
			{ band: "5", available: "true", text: "5 GHz 80 MHz" },
		]);
	});

	it("renders NO 6 GHz node and NO reason — the radio positively lacks the band", () => {
		const { container, queryByTestId } = mount([["0", radio(ROCK_RTL8852BE)]]);

		expect(
			container.querySelector(
				'[data-testid="wifi-band-option"][data-band="6"]',
			),
		).toBeNull();
		expect(queryByTestId("wifi-band-blocked-reason")).toBeNull();
		expect(queryByTestId("wifi-open-country")).toBeNull();
	});

	it("states the same-channel limit on its station+AP combo", () => {
		const { getByTestId } = mount([["0", radio(ROCK_RTL8852BE)]]);

		const note = getByTestId("wifi-sta-ap-combo");
		expect(note.dataset.sameChannel).toBe("true");
		expect(note.textContent).toContain("one channel");
	});
});

describe("WifiSection — a Wi-Fi 7 radio whose domain allows 6 GHz", () => {
	it("offers all three bands, 6 GHz enabled, with no reason band", () => {
		const { container, getByTestId, queryByTestId } = mount([
			["0", radio(MT7925)],
		]);

		expect(getByTestId("wifi-generation-badge").textContent?.trim()).toBe(
			"Wi-Fi 7",
		);
		expect(bandsOf(container)).toEqual([
			{ band: "2.4", available: "true", text: "2.4 GHz 40 MHz" },
			{ band: "5", available: "true", text: "5 GHz 160 MHz" },
			{ band: "6", available: "true", text: "6 GHz 320 MHz" },
		]);
		expect(queryByTestId("wifi-band-blocked-reason")).toBeNull();
	});

	it("states that its station+AP combo needs no shared channel", () => {
		const { getByTestId } = mount([["0", radio(MT7925)]]);

		expect(getByTestId("wifi-sta-ap-combo").dataset.sameChannel).toBe("false");
	});
});

describe("WifiSection — a 6 GHz band the regulatory domain forbids", () => {
	const blockedByDomain = {
		...MT7925,
		regulatory: { country: "CO", is6GhzLegal: false, self_managed: false },
	};

	it("keeps 6 GHz visible, marked unavailable, never hidden", () => {
		const { container } = mount([["0", radio(blockedByDomain)]]);

		const six = container.querySelector<HTMLElement>(
			'[data-testid="wifi-band-option"][data-band="6"]',
		);
		expect(six, "a band the radio carries must stay on screen").not.toBeNull();
		expect(six?.dataset.available).toBe("false");
		expect(six?.getAttribute("aria-disabled")).toBe("true");
	});

	it("carries an on-screen reason naming the country, not a raw token", () => {
		const { getByTestId } = mount([["0", radio(blockedByDomain)]]);

		const band = getByTestId("wifi-band-blocked-reason");
		expect(band.dataset.blockedBy).toBe("regulatory-domain");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain("CO");
		expect(band.textContent).not.toContain("network.wifiCapability");
		// The amber attention register, because there IS something to do about it.
		expect(band.className).toContain("status-warning");
	});

	it("routes the operator to the country surface", async () => {
		const onOpenCountry = vi.fn();
		const { getByTestId } = mount(
			[["0", radio(blockedByDomain)]],
			onOpenCountry,
		);

		getByTestId("wifi-open-country").click();
		expect(onOpenCountry).toHaveBeenCalledTimes(1);
	});

	it("says NO country is set when the world domain is what forbids it", () => {
		const { getByTestId } = mount([
			[
				"0",
				radio({
					...MT7925,
					regulatory: {
						country: "00",
						is6GhzLegal: false,
						self_managed: false,
					},
				}),
			],
		]);

		const band = getByTestId("wifi-band-blocked-reason");
		expect(band.textContent).toContain("No country is set");
		// `00` is the kernel's world-domain token, not something to show an operator.
		expect(band.textContent).not.toContain("(00)");
		expect(getByTestId("wifi-open-country")).toBeTruthy();
	});
});

describe("WifiSection — a self-managed radio forbidding its own 6 GHz", () => {
	const selfManaged = {
		...MT7925,
		regulatory: { country: "US", is6GhzLegal: false, self_managed: true },
	};

	it("explains it is the adapter's firmware, in the calm register", () => {
		const { getByTestId } = mount([["0", radio(selfManaged)]]);

		const band = getByTestId("wifi-band-blocked-reason");
		expect(band.dataset.blockedBy).toBe("self-managed");
		expect(band.textContent).toContain("firmware");
		expect(band.className).toContain("status-info");
		expect(band.className).not.toContain("status-warning");
	});

	it("offers NO country action — the dialog provably cannot move it", () => {
		const { queryByTestId } = mount([["0", radio(selfManaged)]]);

		expect(queryByTestId("wifi-open-country")).toBeNull();
	});
});

describe("WifiSection — WPA3 is tri-state", () => {
	it("renders `unknown` as its own visibly distinct state", () => {
		const { getByTestId } = mount([
			["0", radio({ ...ROCK_RTL8852BE, wpa3Sae: "unknown" })],
		]);

		const chip = getByTestId("wifi-wpa3");
		expect(chip.dataset.state).toBe("unknown");
		expect(chip.textContent).toContain("not reported");
	});

	it("draws nothing for a radio that positively cannot do WPA3", () => {
		const { queryByTestId } = mount([
			["0", radio({ ...ROCK_RTL8852BE, wpa3Sae: "unsupported" })],
		]);

		expect(queryByTestId("wifi-wpa3")).toBeNull();
	});
});

describe("WifiSection — zero radios is a stated fact", () => {
	it("names the state and explains it instead of leaving a blank section", () => {
		const { getByTestId, queryByTestId } = mount([]);

		const empty = getByTestId("wifi-no-adapter");
		expect(empty.getAttribute("role")).toBe("status");
		expect(empty.textContent).toContain("No WiFi interfaces found");
		expect(empty.textContent).toContain("no usable Wi-Fi radio");
		expect(queryByTestId("wifi-capabilities")).toBeNull();
	});
});

describe("WifiSection — every radio answers for itself", () => {
	it("derives each adapter's strip from its own report", () => {
		const { getAllByTestId } = mount([
			["0", radio(ROCK_RTL8852BE)],
			["1", { ...radio(MT7925), ifname: "wlan1" } as WifiInterface],
		]);

		const strips = getAllByTestId("wifi-capabilities");
		expect(strips.map((s) => s.dataset.generation)).toEqual(["wifi6", "wifi7"]);
		expect(
			getAllByTestId("wifi-band-option").map((b) => b.dataset.band),
		).toEqual(["2.4", "5", "2.4", "5", "6"]);
	});

	it("leaves a report-less sibling bare while the other keeps its strip", () => {
		const { getAllByTestId } = mount([
			["0", radio(ROCK_RTL8852BE)],
			["1", { ...radio(), ifname: "wlan1" } as WifiInterface],
		]);

		const strips = getAllByTestId("wifi-capabilities");
		expect(strips).toHaveLength(1);
		expect(strips[0]?.dataset.device).toBe("0");
	});
});

describe("WifiSection — the capability strip is a demoted hardware tag", () => {
	it("never borrows the phosphor-lime accent reserved for the live signal", () => {
		const { getByTestId } = mount([["0", radio(MT7925)]]);

		const strip = getByTestId("wifi-capabilities");
		expect(strip.innerHTML).not.toContain("text-primary");
		expect(strip.innerHTML).not.toContain("bg-primary");
	});

	it("resolves every label through i18n rather than printing a dotted key", () => {
		const { getByTestId } = mount([["0", radio(MT7925)]]);

		expect(getByTestId("wifi-capabilities").textContent).not.toContain(
			"network.wifiCapability",
		);
	});
});

/**
 * The QA-failure lock. An older backend sends no `capabilities` at all, so the
 * row must be the row it always was — never a blank section, never an apology
 * placeholder, and never a single node out of place.
 */
describe("WifiSection — a backend that reports no capabilities", () => {
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

	it("renders no capability nodes of any kind", () => {
		const { queryByTestId, container } = mount([["0", radio()]]);

		expect(queryByTestId("wifi-capabilities")).toBeNull();
		expect(queryByTestId("wifi-generation-badge")).toBeNull();
		expect(queryByTestId("wifi-band-blocked-reason")).toBeNull();
		expect(container.querySelectorAll("[data-band]")).toHaveLength(0);
	});

	it("still renders the whole legacy row — it is not an empty state", () => {
		const { getByTestId, container } = mount([["0", radio()]]);

		expect(container.textContent).toContain("wlan0");
		expect(container.textContent).toContain("CERALIVE");
		expect(getByTestId("open-wifi-selector-dialog").dataset.device).toBe("0");
		expect(
			container.querySelector('[data-testid="wifi-no-adapter"]'),
		).toBeNull();
	});

	it("is byte-identical to a capable row with its strip removed", () => {
		const legacy = mount([["0", radio()]]);
		const capable = mount([["0", radio(ROCK_RTL8852BE)]]);

		const capableSection = capable.container.querySelector("section");
		capableSection
			?.querySelector('[data-testid="wifi-capabilities"]')
			?.remove();

		expect(capableSection).not.toBeNull();
		expect(normalize(capableSection as Element)).toBe(
			normalize(legacy.container.querySelector("section") as Element),
		);
	});
});
