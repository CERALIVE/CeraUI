// @vitest-environment jsdom
/**
 * The phone Live screen opens on the stream (LiveGlance), with the engineering
 * telemetry folded into Details (LiveDetails) and the bitrate slider in a
 * sheet (PhoneBitrateControl).
 */

import { setLocale } from "@ceraui/i18n/svelte";
import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectIngestLinks } from "$lib/components/custom/ingest-link-view";
import { en, es } from "../../tests/helpers/catalog";
import CompactRate from "./CompactRate.svelte";
import LiveDetails from "./LiveDetails.svelte";
import LiveGlance from "./LiveGlance.svelte";
import PhoneBitrateControl from "./PhoneBitrateControl.svelte";

function telemetry(
	links: { iface: string; weight: number; bps?: number; stale?: boolean }[],
) {
	const frame: LinkTelemetryMessage = {
		links: links.map((l, i) => ({
			conn_id: String(i + 1),
			link_id: `link-${l.iface}`,
			iface: l.iface,
			rtt_ms: 40,
			nak_count: 0,
			weight_percent: l.weight,
			bitrate_bps: l.bps,
			stale: l.stale ?? false,
		})),
	};
	return projectIngestLinks(frame.links);
}

describe("LiveGlance", () => {
	afterEach(cleanup);

	it("shows the bitrate, one verdict and a bar per link, without engine numbers", () => {
		const { container } = render(LiveGlance, {
			props: {
				bitrateKbps: 4200,
				bitrateMeasured: true,
				feed: "fresh",
				rows: telemetry([
					{ iface: "usb0", weight: 100, bps: 3_000_000 },
					{ iface: "wlan0", weight: 0, bps: 1_200_000 },
				]),
			},
		});
		expect(screen.getByRole("img", { name: "4.2 Mbps" })).toBeDefined();
		expect(container.textContent).toContain(en.hud.bitrateSending);
		expect(container.textContent).toContain(en.live.glance.allSending);
		expect(container.querySelectorAll("li")).toHaveLength(2);
		expect(screen.getAllByRole("listitem")[1]?.textContent).toContain(
			"1.2 Mbps",
		);
		expect(container.textContent).not.toContain(en.live.ingest.rtt);
		expect(container.textContent).not.toContain(en.live.ingest.nak);
	});

	it("marks the snapshot stale without claiming a link failed", () => {
		render(LiveGlance, {
			props: {
				bitrateKbps: 2000,
				feed: "stale",
				rows: telemetry([
					{ iface: "usb0", weight: 100, bps: 2_000_000, stale: true },
					{ iface: "wlan0", weight: 0, bps: 0, stale: true },
				]),
			},
		});
		expect(screen.getByRole("status").textContent?.trim()).toBe(
			en.live.glance.linkDown,
		);
		for (const row of screen.getAllByRole("listitem"))
			expect(row.textContent).toContain("—");
	});

	it("a fresh link with zero traffic reads idle and draws no fill despite positive allocation", () => {
		const { container } = render(LiveGlance, {
			props: {
				bitrateKbps: 2000,
				feed: "fresh",
				rows: telemetry([
					{ iface: "usb0", weight: 60, bps: 2_000_000 },
					{ iface: "wlan0", weight: 40, bps: 0 },
				]),
			},
		});
		expect(screen.getByRole("status").textContent?.trim()).toBe(
			en.live.glance.linkIdle,
		);
		expect(
			screen.getAllByRole("listitem")[1]?.querySelector("[style*=width]"),
		).toBeNull();
		expect(container.textContent).toContain(en.live.glance.linkIdle);
		expect(container.textContent).not.toContain(en.live.glance.allSending);
	});

	it("keeps a single intelligible rate for screen readers", () => {
		render(LiveGlance, {
			props: { bitrateKbps: 3600, rows: [], feed: "waiting" },
		});
		expect(screen.getByRole("img", { name: "3.6 Mbps" })).toBeDefined();
	});

	it("waits while no link has reported", () => {
		const { container } = render(LiveGlance, {
			props: { bitrateKbps: 6000, rows: [], feed: "waiting" },
		});
		expect(screen.getByRole("status").textContent?.trim()).toBe(
			en.live.ingest.waiting,
		);
		expect(container.querySelectorAll("li")).toHaveLength(0);
	});

	it("keeps an absent headline distinct from a measured zero", async () => {
		const { rerender } = render(CompactRate, {
			props: { kbps: undefined },
		});
		expect(screen.getByText("—")).toBeDefined();
		await rerender({ kbps: 0 });
		expect(screen.getByRole("img", { name: "0 kbps" })).toBeDefined();
	});

	it("does not infer traffic from a weight-only snapshot", () => {
		render(LiveGlance, {
			props: {
				rows: telemetry([{ iface: "usb0", weight: 100 }]),
				feed: "fresh",
			},
		});
		expect(screen.getByRole("status").textContent?.trim()).toBe(
			en.live.glance.down,
		);
		expect(screen.getByRole("listitem").textContent).toContain("—");
	});

	it("keeps link names and readings paired when a sender reorders the roster", async () => {
		const wired = { iface: "eth0", weight: 50, bps: 2_000_000 };
		const wifi = { iface: "wlan0", weight: 50, bps: 1_000_000 };
		const { rerender } = render(LiveGlance, {
			props: { rows: telemetry([wired, wifi]), feed: "fresh" },
		});
		const readRows = () =>
			screen
				.getAllByRole("listitem")
				.map((row) => row.textContent?.replace(/\s+/g, " ").trim());
		const [first, second] = readRows();
		expect(first).toBe("Ethernet 1 2 Mbps");
		expect(second).toBe("Wi-Fi 1 1 Mbps");
		await rerender({ rows: telemetry([wifi, wired]) });
		expect(readRows()).toEqual([second, first]);
	});
});

describe("LiveDetails", () => {
	const body = createRawSnippet(() => ({
		render: () => "<p data-probe>engine numbers</p>",
	}));
	let wide = false;

	beforeEach(() => {
		localStorage.clear();
		wide = false;
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: wide,
				addEventListener: () => {},
				removeEventListener: () => {},
			})),
		);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	function details(container: HTMLElement): HTMLDetailsElement {
		const element = container.querySelector("details");
		if (!element) throw new Error("Details disclosure did not render");
		return element;
	}

	it("starts folded on a phone, with its content still mounted", () => {
		const { container } = render(LiveDetails, { props: { children: body } });
		expect(details(container).open).toBe(false);
		expect(container.querySelector("[data-probe]")).not.toBeNull();
	});

	it("remembers the streamer's choice on this device", async () => {
		const { container } = render(LiveDetails, { props: { children: body } });
		details(container).open = true;
		await fireEvent(details(container), new Event("toggle"));
		expect(localStorage.getItem("ceraui.live.detailsOpen")).toBe("true");
		cleanup();
		const again = render(LiveDetails, { props: { children: body } });
		expect(details(again.container).open).toBe(true);
	});

	it("is open on a desktop-width screen whatever was stored", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		wide = true;
		const { container } = render(LiveDetails, { props: { children: body } });
		expect(details(container).open).toBe(true);
	});

	it("is forced open in the post-stream summary", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		const { container } = render(LiveDetails, {
			props: { children: body, forceOpen: true },
		});
		expect(details(container).open).toBe(true);
	});

	it("cannot be folded while forced open, and the stored choice applies again after", async () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		const { container, rerender } = render(LiveDetails, {
			props: { children: body, forceOpen: true },
		});
		let visibility: string | undefined;
		const summary = container.querySelector("summary");
		if (summary) visibility = getComputedStyle(summary).display;
		expect(visibility).toBe("none");
		// Closing it some other way is undone while forced open.
		details(container).open = false;
		await fireEvent(details(container), new Event("toggle"));
		expect(details(container).open).toBe(true);
		expect(localStorage.getItem("ceraui.live.detailsOpen")).toBe("false");
		await rerender({ forceOpen: false });
		expect(details(container).open).toBe(false);
	});

	it("does not overwrite the phone's folded preference while wide", () => {
		localStorage.setItem("ceraui.live.detailsOpen", "false");
		wide = true;
		const first = render(LiveDetails, { props: { children: body } });
		expect(details(first.container).open).toBe(true);
		cleanup();
		wide = false;
		const second = render(LiveDetails, { props: { children: body } });
		expect(details(second.container).open).toBe(false);
	});

	it("renders localized Details copy that names what is inside", () => {
		setLocale("es");
		try {
			render(LiveDetails, { props: { children: body } });
			expect(screen.getByText(es.live.glance.details)).toBeDefined();
			expect(screen.getByText(es.live.glance.detailsHint)).toBeDefined();
		} finally {
			setLocale("en");
		}
	});
});

describe("PhoneBitrateControl", () => {
	beforeEach(() => {
		// The slider measures itself; jsdom has no ResizeObserver.
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("closes the sheet when the screen widens past 640 px", async () => {
		const viewport = Object.assign(new EventTarget(), { matches: false });
		// The loading dialog subscribes to a different breakpoint.
		vi.stubGlobal("matchMedia", (query: string) =>
			query === "(min-width: 640px)"
				? viewport
				: Object.assign(new EventTarget(), { matches: false }),
		);
		render(PhoneBitrateControl, {
			props: {
				bitrateDraft: 5000,
				bitrateLabel: "5 Mbps",
				step: 250,
				bitrateMin: 500,
				bitrateMax: 12000,
				sliderMin: 1000,
				sliderMax: 10000,
				onStep: () => {},
				onSliderChange: () => {},
				onSliderCommit: () => {},
			},
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Change bitrate limit, now 5 Mbps" }),
		);
		await screen.findByRole("dialog", { name: en.live.adjustBitrate });
		viewport.matches = true;
		viewport.dispatchEvent(new Event("change"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("the phone value button opens the same adjuster in a sheet", async () => {
		const onStep = vi.fn();
		render(PhoneBitrateControl, {
			props: {
				bitrateDraft: 5000,
				bitrateLabel: "5 Mbps",
				step: 250,
				bitrateMin: 500,
				bitrateMax: 12000,
				sliderMin: 1000,
				sliderMax: 10000,
				onStep,
				onSliderChange: () => {},
				onSliderCommit: () => {},
			},
		});
		const open = screen.getByRole("button", {
			name: "Change bitrate limit, now 5 Mbps",
		});
		await fireEvent.click(open);
		const sheet = await screen.findByRole("dialog");
		expect(sheet.textContent).toContain(en.live.adjustBitrate);
		await fireEvent.click(
			within(sheet).getByRole("button", { name: /^\+250 / }),
		);
		await waitFor(() => expect(onStep).toHaveBeenCalledWith(250));
	});
});
