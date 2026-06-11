// @vitest-environment jsdom
/**
 * IngestStats — bonded-ingest telemetry panel (Task 21).
 *
 * Renders the existing `status.linkTelemetry` feed as a per-link table near the
 * Live streaming status. This suite locks the render contract from fixture
 * snapshots:
 *   1. Populated — one row per uplink with iface / RTT / NAK / weight; totals
 *      footer sums NAK and weight across links.
 *   2. Stale     — a link's `stale` flag sets data-stale="true" on its row and
 *      renders a StaleBadge; siblings stay non-stale.
 *   3. Waiting   — null / empty feed keeps the panel mounted and shows the
 *      "waiting" line with zero rows (so the panel never disappears mid-stream).
 *   4. Sender constants — rtt_ms=0 and weight_percent=100 render literally, not
 *      as placeholders (they are valid srtla_send values).
 */

import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import IngestStats from "./IngestStats.svelte";

const TWO_LINKS: LinkTelemetryMessage = {
	links: [
		{
			conn_id: "0",
			iface: "eth0",
			rtt_ms: 18,
			nak_count: 2,
			weight_percent: 60,
			stale: false,
		},
		{
			conn_id: "1",
			iface: "wlan0",
			rtt_ms: 47,
			nak_count: 5,
			weight_percent: 40,
			stale: false,
		},
	],
};

function panelOf(container: HTMLElement): HTMLElement {
	const panel = container.querySelector<HTMLElement>(
		'[data-testid="ingest-stats"]',
	);
	expect(panel, "panel must render").not.toBeNull();
	return panel as HTMLElement;
}

describe("IngestStats — render contract (Task 21)", () => {
	it("renders one row per link with iface, RTT, NAK, and weight", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: TWO_LINKS },
		});
		const panel = panelOf(container);

		const rows = panel.querySelectorAll('[data-testid="ingest-row"]');
		expect(rows).toHaveLength(2);

		const eth0 = panel.querySelector<HTMLElement>('[data-iface="eth0"]');
		const wlan0 = panel.querySelector<HTMLElement>('[data-iface="wlan0"]');
		expect(eth0).not.toBeNull();
		expect(wlan0).not.toBeNull();

		expect(
			within(eth0 as HTMLElement)
				.getByTestId("ingest-rtt")
				.textContent?.trim(),
		).toBe("18 ms");
		expect(
			within(eth0 as HTMLElement)
				.getByTestId("ingest-nak")
				.textContent?.trim(),
		).toBe("2");
		expect(
			within(eth0 as HTMLElement)
				.getByTestId("ingest-weight")
				.textContent?.trim(),
		).toBe("60%");

		expect(
			within(wlan0 as HTMLElement)
				.getByTestId("ingest-rtt")
				.textContent?.trim(),
		).toBe("47 ms");
		expect(
			within(wlan0 as HTMLElement)
				.getByTestId("ingest-weight")
				.textContent?.trim(),
		).toBe("40%");

		// Neither row is stale in the happy path.
		expect((eth0 as HTMLElement).getAttribute("data-stale")).toBe("false");
		expect((wlan0 as HTMLElement).getAttribute("data-stale")).toBe("false");
	});

	it("sums NAK and weight across links in the totals footer", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: TWO_LINKS },
		});
		const panel = panelOf(container);

		expect(
			panel
				.querySelector('[data-testid="ingest-total-nak"]')
				?.textContent?.trim(),
		).toBe("7");
		expect(
			panel
				.querySelector('[data-testid="ingest-total-weight"]')
				?.textContent?.trim(),
		).toBe("100%");
	});

	it("marks a stale link's row and shows a stale badge; siblings stay fresh", () => {
		const telemetry: LinkTelemetryMessage = {
			links: [
				{
					conn_id: "0",
					iface: "eth0",
					rtt_ms: 18,
					nak_count: 2,
					weight_percent: 60,
					stale: false,
				},
				{
					conn_id: "1",
					iface: "wlan0",
					rtt_ms: 47,
					nak_count: 5,
					weight_percent: 40,
					stale: true,
				},
			],
		};
		const { container } = render(IngestStats, { props: { telemetry } });
		const panel = panelOf(container);

		const staleRow = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-row"][data-iface="wlan0"]',
		);
		expect(staleRow?.getAttribute("data-stale")).toBe("true");
		// The StaleBadge marks the stale interface by name.
		expect(
			panel.querySelector('[data-stale-interface="wlan0"]'),
		).not.toBeNull();

		const freshRow = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-row"][data-iface="eth0"]',
		);
		expect(freshRow?.getAttribute("data-stale")).toBe("false");
		expect(panel.querySelector('[data-stale-interface="eth0"]')).toBeNull();
	});

	it("keeps the panel mounted with a waiting line when the feed is null", () => {
		const { container } = render(IngestStats, { props: { telemetry: null } });
		const panel = panelOf(container);

		expect(panel.querySelectorAll('[data-testid="ingest-row"]')).toHaveLength(
			0,
		);
		expect(
			panel.querySelector('[data-testid="ingest-waiting"]'),
		).not.toBeNull();
	});

	it("keeps the panel mounted with a waiting line when the link list is empty", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: { links: [] } },
		});
		const panel = panelOf(container);

		expect(panel.querySelectorAll('[data-testid="ingest-row"]')).toHaveLength(
			0,
		);
		expect(
			panel.querySelector('[data-testid="ingest-waiting"]'),
		).not.toBeNull();
	});

	it("renders sender constants rtt_ms=0 and weight_percent=100 literally", () => {
		const telemetry: LinkTelemetryMessage = {
			links: [
				{
					conn_id: "0",
					iface: "eth0",
					rtt_ms: 0,
					nak_count: 0,
					weight_percent: 100,
					stale: false,
				},
			],
		};
		const { container } = render(IngestStats, { props: { telemetry } });
		const panel = panelOf(container);

		const row = panel.querySelector<HTMLElement>('[data-iface="eth0"]');
		expect(
			within(row as HTMLElement)
				.getByTestId("ingest-rtt")
				.textContent?.trim(),
		).toBe("0 ms");
		expect(
			within(row as HTMLElement)
				.getByTestId("ingest-weight")
				.textContent?.trim(),
		).toBe("100%");
	});
});
