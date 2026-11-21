// @vitest-environment jsdom
/**
 * The phone Live screen opens on the stream (LiveGlance), with the engineering
 * telemetry folded into Details (LiveDetails) and the bitrate slider in a
 * sheet (PhoneBitrateControl).
 */
import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";
import LiveDetails from "./LiveDetails.svelte";
import LiveGlance from "./LiveGlance.svelte";
import PhoneBitrateControl from "./PhoneBitrateControl.svelte";

function telemetry(
	links: { iface: string; weight: number; stale?: boolean }[],
): LinkTelemetryMessage {
	return {
		links: links.map((l, i) => ({
			conn_id: i + 1,
			iface: l.iface,
			rtt_ms: 40,
			nak_count: 0,
			weight_percent: l.weight,
			stale: l.stale ?? false,
		})),
	} as unknown as LinkTelemetryMessage;
}

describe("LiveGlance", () => {
	afterEach(cleanup);

	it("shows the bitrate, one verdict and a bar per link, without engine numbers", () => {
		const { container } = render(LiveGlance, {
			props: {
				bitrate: "4.2 Mbps",
				bitrateMeasured: true,
				telemetry: telemetry([
					{ iface: "usb0", weight: 60 },
					{ iface: "wlan0", weight: 40 },
				]),
			},
		});
		expect(container.textContent).toContain("4.2 Mbps");
		expect(container.textContent).toContain(en.hud.bitrateSending);
		expect(container.textContent).toContain(en.live.glance.allSending);
		expect(container.querySelectorAll("li")).toHaveLength(2);
		expect(container.textContent).toContain("60%");
		expect(container.textContent).not.toContain(en.live.ingest.rtt);
		expect(container.textContent).not.toContain(en.live.ingest.nak);
	});

	it("says a link stopped reporting and marks it, without claiming it failed", () => {
		const { container } = render(LiveGlance, {
			props: {
				bitrate: "2 Mbps",
				telemetry: telemetry([
					{ iface: "usb0", weight: 100 },
					{ iface: "wlan0", weight: 0, stale: true },
				]),
			},
		});
		expect(
			container.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
		).toBe("stopped-reporting");
		expect(container.textContent).toContain(en.live.glance.linkDown);
		expect(
			container.querySelector('li[data-stale="true"]')?.textContent,
		).toContain(en.live.glance.down);
	});

	it("a fresh link with no share of the bond reads idle, not sending", () => {
		const { container } = render(LiveGlance, {
			props: {
				bitrate: "2 Mbps",
				telemetry: telemetry([
					{ iface: "usb0", weight: 100 },
					{ iface: "wlan0", weight: 0 },
				]),
			},
		});
		expect(
			container.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
		).toBe("idle");
		expect(container.textContent).toContain(en.live.glance.linkIdle);
		expect(container.textContent).not.toContain(en.live.glance.allSending);
	});

	it("stacks the unit (Mb over s) and keeps the plain rate for screen readers", () => {
		const { container } = render(LiveGlance, {
			props: { bitrate: "3.6 Mbps", telemetry: null },
		});
		const rate = container.querySelector("[data-compact-rate]");
		expect(rate?.querySelector(".sr-only")?.textContent).toBe("3.6 Mbps");
		expect(rate?.textContent?.replace(/\s+/g, "")).toContain("3.6Mbs");
	});

	it("waits while no link has reported", () => {
		const { container } = render(LiveGlance, {
			props: { bitrate: "6 Mbps", telemetry: null },
		});
		expect(
			container.querySelector("[data-verdict]")?.getAttribute("data-verdict"),
		).toBe("waiting");
		expect(container.querySelectorAll("li")).toHaveLength(0);
	});

	it("is hidden from 1024 px, so the desktop screen is unchanged", () => {
		const { container } = render(LiveGlance, {
			props: { bitrate: "6 Mbps", telemetry: null },
		});
		expect(
			container
				.querySelector("[data-live-glance]")
				?.classList.contains("lg:hidden"),
		).toBe(true);
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
		return container.querySelector("details") as HTMLDetailsElement;
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
		const summary = container.querySelector("summary") as HTMLElement;
		expect(summary.classList.contains("hidden")).toBe(true);
		// Closing it some other way is undone while forced open.
		details(container).open = false;
		await fireEvent(details(container), new Event("toggle"));
		expect(details(container).open).toBe(true);
		expect(localStorage.getItem("ceraui.live.detailsOpen")).toBe("false");
		await rerender({ forceOpen: false });
		expect(details(container).open).toBe(false);
	});

	it("uses the width-only breakpoint, the same as the stream card", () => {
		render(LiveDetails, { props: { children: body } });
		const calls = (
			window.matchMedia as unknown as { mock: { calls: string[][] } }
		).mock.calls;
		expect(calls.at(-1)?.[0]).toBe("(min-width: 1024px)");
	});

	it("names what is inside, in every locale", async () => {
		const { ar, de, es, fr, hi, ja, ko, ptBR, zh } = await import(
			"../../tests/helpers/catalog"
		);
		for (const dict of [en, ar, de, es, fr, hi, ja, ko, ptBR, zh]) {
			const g = dict.live.glance;
			for (const v of [
				g.title,
				g.allSending,
				g.linkDown,
				g.linkIdle,
				g.down,
				g.details,
				g.detailsHint,
				g.changeBitrate,
			]) {
				expect(v.length).toBeGreaterThan(0);
			}
			expect(g.changeBitrate).toContain("{bitrate}");
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
		let listener: (() => void) | undefined;
		const query = {
			matches: false,
			addEventListener: (_: string, fn: () => void) => (listener = fn),
			removeEventListener: () => {},
		};
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => query),
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
			screen.getByRole("button", { name: "Change bitrate, now 5 Mbps" }),
		);
		await screen.findByRole("dialog");
		query.matches = true;
		listener?.();
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
			name: "Change bitrate, now 5 Mbps",
		});
		await fireEvent.click(open);
		const sheet = await screen.findByRole("dialog");
		expect(sheet.textContent).toContain(en.live.adjustBitrate);
		const plus = [...sheet.querySelectorAll("button")].find((b) =>
			b.getAttribute("aria-label")?.startsWith("+"),
		);
		await fireEvent.click(plus as HTMLButtonElement);
		await waitFor(() => expect(onStep).toHaveBeenCalledWith(250));
	});
});
