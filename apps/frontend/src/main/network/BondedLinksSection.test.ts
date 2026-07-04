// @vitest-environment jsdom
/**
 * BondedLinksSection — per-link telemetry JOIN proof (T5).
 *
 * The backend mock (buildMockLinkTelemetry) emits `status.linkTelemetry[].iface`
 * values that MUST exactly equal the FE-derived `link.id`, or every card renders
 * a "--" placeholder (green backend test, dead UI — the #1 failure mode). This
 * suite reproduces the `streaming-active` canonical link set (eth0 + usb0/usb1 +
 * wlan0/wlan1) and the mock's telemetry shape, then proves every card joins a
 * REAL RTT value instead of "--".
 */

import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type { LinkSignal } from "$lib/types/hud";

import BondedLinksSection from "./BondedLinksSection.svelte";

const PLACEHOLDER = "--";

// The exact bonded ids the frontend derives for MOCK_SCENARIO=streaming-active
// (T4 canonical set) — eth0 always, usbN modems, wifi radios.
const STREAMING_ACTIVE_IFACES = ["eth0", "usb0", "usb1", "wlan0", "wlan1"];

function linkFor(id: string, index: number): LinkSignal {
	const type: LinkSignal["type"] = id.startsWith("wlan")
		? "wifi"
		: id.startsWith("eth")
			? "ethernet"
			: "modem";
	return {
		id,
		type,
		linkIndex: index,
		signal: type === "modem" ? 72 : type === "wifi" ? 55 : null,
		label: id,
		isConnected: true,
		isStale: false,
		throughputKbps: 5000,
		enabled: true,
		connectionState: "connected",
	};
}

// Mirror of buildMockLinkTelemetry's row shape for the same iface set: plausible
// values whose iface equals the FE link id (the join under test).
function streamingActiveTelemetry(): LinkTelemetryMessage {
	return {
		links: STREAMING_ACTIVE_IFACES.map((iface, index) => ({
			conn_id: String(index),
			iface,
			rtt_ms: 25 + index * 6,
			nak_count: index % 3,
			weight_percent: 100,
			stale: false,
		})),
	};
}

function cardFor(container: HTMLElement, id: string): HTMLElement {
	const card = container.querySelector<HTMLElement>(
		`[data-testid="bonded-link-card"][data-link-id="${id}"]`,
	);
	expect(card, `card for ${id} must render`).not.toBeNull();
	return card as HTMLElement;
}

describe("BondedLinksSection — mock link-telemetry join (T5)", () => {
	it("renders a REAL RTT (not '--') on every card for the streaming-active set", () => {
		const links = STREAMING_ACTIVE_IFACES.map(linkFor);
		const { container } = render(BondedLinksSection, {
			props: {
				links,
				modemEntries: [],
				linkTelemetry: streamingActiveTelemetry(),
			},
		});

		for (const iface of STREAMING_ACTIVE_IFACES) {
			const card = cardFor(container, iface);
			const rtt =
				within(card).getByTestId("link-rtt").textContent?.trim() ?? "";
			expect(
				rtt,
				`${iface} must show a real RTT, not the placeholder`,
			).not.toBe(PLACEHOLDER);
			expect(rtt).toMatch(/^\d+\s/);
			expect(within(card).getByTestId("link-weight").textContent?.trim()).toBe(
				"100%",
			);
			expect(
				within(card).getByTestId("link-telemetry").getAttribute("data-stale"),
			).toBe("false");
		}
	});

	it("renders exactly one compact single-line row per link (row-height class changed)", () => {
		const links = STREAMING_ACTIVE_IFACES.map(linkFor);
		const { container } = render(BondedLinksSection, {
			props: {
				links,
				modemEntries: [],
				linkTelemetry: streamingActiveTelemetry(),
			},
		});

		const rows = container.querySelectorAll<HTMLElement>(
			'[data-testid="bonded-link-card"]',
		);
		expect(rows.length).toBe(STREAMING_ACTIVE_IFACES.length);

		for (const row of rows) {
			// Single-line row: horizontal flex, vertically centered, compact height.
			expect(row.className).toContain("items-center");
			expect(row.className).toContain("py-1.5");
			// The old two-row layout (flex-col) is gone.
			expect(row.className).not.toContain("flex-col");
		}
	});

	it("carries all three telemetry cells inline on the SAME row as identity + speed", () => {
		const links = STREAMING_ACTIVE_IFACES.map(linkFor);
		const { container } = render(BondedLinksSection, {
			props: {
				links,
				modemEntries: [],
				linkTelemetry: streamingActiveTelemetry(),
			},
		});

		for (const iface of STREAMING_ACTIVE_IFACES) {
			const card = cardFor(container, iface);
			// identity + speed + all three telemetry cells share ONE row element.
			expect(within(card).getByTestId("link-rtt")).toBeTruthy();
			expect(within(card).getByTestId("link-nak")).toBeTruthy();
			expect(within(card).getByTestId("link-weight")).toBeTruthy();
			expect(
				card.querySelector('[data-live-value]'),
				`${iface} speed badge shares the row`,
			).not.toBeNull();
		}
	});

	it("renders Skeletons in-place (not '--') while the telemetry feed has not arrived", () => {
		const links = [linkFor("eth0", 0)];
		const { container } = render(BondedLinksSection, {
			// linkTelemetry omitted → undefined → telemetryLoading = true.
			props: { links, modemEntries: [] },
		});

		const card = cardFor(container, "eth0");
		expect(
			within(card).getByTestId("link-telemetry-skeleton"),
			"loading feed shows a Skeleton",
		).toBeTruthy();
		// No "--" flicker: the value cells are not mounted while loading.
		expect(within(card).queryByTestId("link-rtt")).toBeNull();
	});

	it("shows '--' when a card's id has no matching telemetry iface (join miss)", () => {
		// A telemetry iface NOT in the derived link-id set proves the negative:
		// the mismatched card falls back to the placeholder.
		const links = [linkFor("eth0", 0)];
		const mismatched: LinkTelemetryMessage = {
			links: [
				{
					conn_id: "0",
					iface: "usb9",
					rtt_ms: 33,
					nak_count: 0,
					weight_percent: 100,
					stale: false,
				},
			],
		};
		const { container } = render(BondedLinksSection, {
			props: { links, modemEntries: [], linkTelemetry: mismatched },
		});

		const card = cardFor(container, "eth0");
		expect(within(card).getByTestId("link-rtt").textContent?.trim()).toBe(
			PLACEHOLDER,
		);
	});
});
