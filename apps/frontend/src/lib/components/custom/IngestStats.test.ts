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
 *      renders a stale Badge; siblings stay non-stale.
 *   3. Waiting   — null / empty feed keeps the panel mounted and shows the
 *      "waiting" line with zero rows (so the panel never disappears mid-stream).
 *   4. Sender constants — rtt_ms=0 and weight_percent=100 render literally, not
 *      as placeholders (they are valid srtla_send values).
 */

import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render, within } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IngestStats from "./IngestStats.svelte";
import {
	computeLinkView,
	createLinkViewCache,
	type Sample,
	sparkPoints,
} from "./ingest-link-view";

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

/**
 * Historical trends — fixed-size ring buffer, per-link sparklines, and the
 * health/degradation alert (this task).
 *
 * The panel takes a single `telemetry` prop; the live feed is simulated by
 * re-rendering with a fresh frame and flushing Svelte's effect that appends one
 * sample per link into the bounded ring. The ring is RAM-only (no persistence,
 * no configurable window) and drops its oldest sample once RING_CAPACITY (60) is
 * reached. The sparkline exposes its buffered sample count (`data-samples`) and
 * trend (`data-trend`) for assertion; per-link health is `data-status`; the
 * bond-level banner is `[data-testid="ingest-alert"]`.
 */
function oneLink(
	rtt: number,
	opts: {
		nak?: number;
		weight?: number;
		conn_id?: string;
		iface?: string;
	} = {},
): LinkTelemetryMessage {
	return {
		links: [
			{
				conn_id: opts.conn_id ?? "0",
				iface: opts.iface ?? "eth0",
				rtt_ms: rtt,
				nak_count: opts.nak ?? 0,
				weight_percent: opts.weight ?? 100,
				stale: false,
			},
		],
	};
}

function sparklineOf(container: HTMLElement, iface = "eth0"): HTMLElement {
	const spark = panelOf(container).querySelector<HTMLElement>(
		`[data-testid="ingest-sparkline"][data-iface="${iface}"]`,
	);
	expect(spark, "sparkline must render for the link").not.toBeNull();
	return spark as HTMLElement;
}

describe("IngestStats — historical trends + health alert", () => {
	it("ring buffer retains at most ~60 samples after 120 feeds (oldest dropped)", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(10) },
		});
		flushSync(); // run the append effect for the initial frame

		// 1 (initial) + 119 = 120 frames fed; the ring must cap at 60.
		for (let i = 1; i < 120; i++) {
			await rerender({ telemetry: oneLink(10 + i) });
			flushSync();
		}

		const samples = Number(sparklineOf(container).getAttribute("data-samples"));
		expect(samples).toBe(60);
		expect(samples).toBeLessThanOrEqual(60);
	});

	it("renders a per-link sparkline whose polyline reflects a rising RTT trend", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(10) },
		});
		flushSync();

		// 60 strictly-rising frames fill the ring with an upward latency ramp.
		for (let i = 1; i < 60; i++) {
			await rerender({ telemetry: oneLink(10 + i * 2) });
			flushSync();
		}

		const spark = sparklineOf(container);
		expect(spark.getAttribute("data-trend")).toBe("rising");

		// The polyline draws one vertex per buffered sample.
		const poly = spark.querySelector("polyline");
		expect(poly).not.toBeNull();
		const pointCount = (poly?.getAttribute("points") ?? "")
			.trim()
			.split(/\s+/)
			.filter(Boolean).length;
		expect(pointCount).toBe(Number(spark.getAttribute("data-samples")));
		expect(pointCount).toBe(60);
	});

	it("activates the health/alert indicator when the RTT trend crosses the threshold", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(20) },
		});
		flushSync();

		// Leading window ~20 ms, trailing window ~80 ms: trail avg > 2× lead avg.
		const ramp = [...Array<number>(9).fill(20), ...Array<number>(10).fill(80)];
		for (const rtt of ramp) {
			await rerender({ telemetry: oneLink(rtt) });
			flushSync();
		}

		const panel = panelOf(container);
		const health = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("degraded");
		expect(sparklineOf(container).getAttribute("data-trend")).toBe("rising");

		// The bond-level degradation banner is raised.
		expect(panel.querySelector('[data-testid="ingest-alert"]')).not.toBeNull();
	});

	it("stays healthy with no alert when RTT holds flat", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(25) },
		});
		flushSync();

		for (let i = 0; i < 30; i++) {
			await rerender({ telemetry: oneLink(25) });
			flushSync();
		}

		const panel = panelOf(container);
		const health = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("healthy");
		expect(panel.querySelector('[data-testid="ingest-alert"]')).toBeNull();
	});
});

async function feedRtts(
	rerender: (props: { telemetry: LinkTelemetryMessage }) => Promise<void>,
	rtts: readonly number[],
): Promise<void> {
	for (const rtt of rtts) {
		await rerender({ telemetry: oneLink(rtt) });
		flushSync();
	}
}

describe("IngestStats — sparkline + degrade edge cases", () => {
	it("draws a flat midline for a single sample without alarming", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: oneLink(42) },
		});
		flushSync();

		const spark = sparklineOf(container);
		expect(spark.getAttribute("data-samples")).toBe("1");
		expect(spark.getAttribute("data-trend")).toBe("flat");
		// A one-vertex history degenerates to a horizontal midline (two points).
		expect(spark.querySelector("polyline")?.getAttribute("points")).toBe(
			"0,12 100,12",
		);
		const health = panelOf(container).querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("healthy");
	});

	it("never alarms on a full ring of rtt_ms=0 startup samples", async () => {
		// rtt_ms=0 is a valid sender constant during link bring-up. Even a full
		// 20-sample window of zeros sits below RTT_FLOOR_MS, so the 2× degrade
		// guard must not fire (trail < floor short-circuits before the ratio).
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(0) },
		});
		flushSync();
		await feedRtts(rerender, Array<number>(24).fill(0));

		const panel = panelOf(container);
		const health = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("healthy");
		expect(panel.querySelector('[data-testid="ingest-alert"]')).toBeNull();
		expect(Number(sparklineOf(container).getAttribute("data-samples"))).toBe(
			25,
		);
	});

	it("does NOT alarm at exactly 2× the leading RTT (boundary, just below)", async () => {
		// lead avg = 20, trail avg = 40 = 2×lead. isDegraded is a strict `>`, so
		// the equal-to-2× case is the highest non-degraded point.
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(20) },
		});
		flushSync();
		await feedRtts(rerender, [
			...Array<number>(9).fill(20),
			...Array<number>(10).fill(40),
		]);

		const panel = panelOf(container);
		const health = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("healthy");
		expect(panel.querySelector('[data-testid="ingest-alert"]')).toBeNull();
		expect(Number(sparklineOf(container).getAttribute("data-samples"))).toBe(
			20,
		);
	});

	it("alarms just past 2× the leading RTT (boundary, just above)", async () => {
		// Same 20-sample window as the just-below case, but trail avg = 41 > 40,
		// crossing the strict 2× threshold into the degraded/alert state.
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(20) },
		});
		flushSync();
		await feedRtts(rerender, [
			...Array<number>(9).fill(20),
			...Array<number>(10).fill(41),
		]);

		const panel = panelOf(container);
		const health = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-health"][data-iface="eth0"]',
		);
		expect(health?.getAttribute("data-status")).toBe("degraded");
		expect(panel.querySelector('[data-testid="ingest-alert"]')).not.toBeNull();
	});
});

describe("IngestStats — ring buffer lifecycle (bound + unmount cleanup)", () => {
	it("caps each conn_id ring at 60 samples under a long feed", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(10) },
		});
		flushSync();
		for (let i = 1; i < 200; i++) {
			await rerender({ telemetry: oneLink(10 + i) });
			flushSync();
		}
		expect(Number(sparklineOf(container).getAttribute("data-samples"))).toBe(
			60,
		);
	});

	it("bounds each conn_id independently — one ring's fill never spills into another", async () => {
		const two = (a: number, b: number): LinkTelemetryMessage => ({
			links: [
				{
					conn_id: "0",
					iface: "eth0",
					rtt_ms: a,
					nak_count: 0,
					weight_percent: 50,
					stale: false,
				},
				{
					conn_id: "1",
					iface: "wlan0",
					rtt_ms: b,
					nak_count: 0,
					weight_percent: 50,
					stale: false,
				},
			],
		});
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: two(10, 10) },
		});
		flushSync();
		for (let i = 1; i < 100; i++) {
			await rerender({ telemetry: two(10 + i, 20 + i) });
			flushSync();
		}
		expect(
			Number(sparklineOf(container, "eth0").getAttribute("data-samples")),
		).toBe(60);
		expect(
			Number(sparklineOf(container, "wlan0").getAttribute("data-samples")),
		).toBe(60);
	});

	it("frees its ring on unmount — a remount starts from an empty history", async () => {
		// The ring is per-component-instance $state, not module-global. Filling it,
		// unmounting, then remounting must show the new instance's count only — if
		// history leaked to a shared/module scope this would read 61, not 1.
		for (let cycle = 0; cycle < 5; cycle++) {
			const { container, rerender, unmount } = render(IngestStats, {
				props: { telemetry: oneLink(10) },
			});
			flushSync();
			for (let i = 1; i < 80; i++) {
				await rerender({ telemetry: oneLink(10 + i) });
				flushSync();
			}
			expect(Number(sparklineOf(container).getAttribute("data-samples"))).toBe(
				60,
			);
			unmount();
		}

		const { container } = render(IngestStats, {
			props: { telemetry: oneLink(99) },
		});
		flushSync();
		expect(Number(sparklineOf(container).getAttribute("data-samples"))).toBe(1);
	});
});

/**
 * Per-session summary + export (device-local).
 *
 * Drives a mock session via the `isStreaming` + `bitrateKbps` props: each
 * telemetry frame while streaming samples one instant; flipping `isStreaming`
 * false folds those samples into the end-of-stream rollup. The summary then
 * surfaces peak/avg bitrate, per-link uptime, and the drop count, plus JSON/CSV
 * export buttons that build a client-side Blob download (no transmission).
 */
function bonded(stale: boolean): LinkTelemetryMessage {
	return {
		links: [
			{
				conn_id: "0",
				iface: "eth0",
				rtt_ms: 18,
				nak_count: 0,
				weight_percent: 50,
				stale: false,
			},
			{
				conn_id: "1",
				iface: "wlan0",
				rtt_ms: 30,
				nak_count: 0,
				weight_percent: 50,
				stale,
			},
		],
	};
}

/** Render, sample two frames (4000→8000 kbps, wlan0 drops), then stop. */
function runMockSession(): HTMLElement {
	const { container, rerender } = render(IngestStats, {
		props: { telemetry: bonded(false), isStreaming: true, bitrateKbps: 4000 },
	});
	flushSync();
	rerender({ telemetry: bonded(true), isStreaming: true, bitrateKbps: 8000 });
	flushSync();
	rerender({ telemetry: { links: [] }, isStreaming: false, bitrateKbps: 8000 });
	flushSync();
	return panelOf(container);
}

describe("IngestStats — session summary + export (device-local)", () => {
	beforeEach(() => {
		// jsdom does not implement the object-URL API; stub so we can spy on it.
		if (typeof URL.createObjectURL !== "function") {
			(URL as unknown as { createObjectURL: () => string }).createObjectURL =
				() => "blob:stub";
		}
		if (typeof URL.revokeObjectURL !== "function") {
			(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
				() => {};
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the rollup after the stream stops", () => {
		const panel = runMockSession();

		expect(
			panel.querySelector('[data-testid="ingest-summary"]'),
		).not.toBeNull();
		// The live table is gone while the summary is shown.
		expect(panel.querySelectorAll('[data-testid="ingest-row"]')).toHaveLength(
			0,
		);

		expect(
			panel
				.querySelector('[data-testid="ingest-summary-peak"]')
				?.textContent?.trim(),
		).toBe("8 Mbps");
		expect(
			panel
				.querySelector('[data-testid="ingest-summary-avg"]')
				?.textContent?.trim(),
		).toBe("6 Mbps");
		expect(
			panel
				.querySelector('[data-testid="ingest-summary-drops"]')
				?.textContent?.trim(),
		).toBe("1");

		const eth0 = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-uptime-row"][data-iface="eth0"]',
		);
		const wlan0 = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-uptime-row"][data-iface="wlan0"]',
		);
		expect(
			within(eth0 as HTMLElement)
				.getByTestId("ingest-uptime")
				.textContent?.trim(),
		).toBe("100%");
		expect(
			within(wlan0 as HTMLElement)
				.getByTestId("ingest-uptime")
				.textContent?.trim(),
		).toBe("50%");
	});

	it("exports a JSON file carrying the rollup fields", async () => {
		const blobs: Blob[] = [];
		vi.spyOn(URL, "createObjectURL").mockImplementation(
			(b: Blob | MediaSource) => {
				blobs.push(b as Blob);
				return "blob:mock";
			},
		);
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		const panel = runMockSession();
		const jsonBtn = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-export-json"]',
		);
		expect(jsonBtn, "export json button must render").not.toBeNull();
		jsonBtn?.click();

		expect(blobs).toHaveLength(1);
		expect((blobs[0] as Blob).type).toBe("application/json");
		const parsed = JSON.parse(await (blobs[0] as Blob).text());
		expect(parsed.peakBitrateKbps).toBe(8000);
		expect(parsed.avgBitrateKbps).toBe(6000);
		expect(parsed.dropCount).toBe(1);
		expect(parsed.links).toEqual([
			{ iface: "eth0", uptimePercent: 100 },
			{ iface: "wlan0", uptimePercent: 50 },
		]);
	});

	it("exports a CSV file carrying the rollup fields", async () => {
		const blobs: Blob[] = [];
		vi.spyOn(URL, "createObjectURL").mockImplementation(
			(b: Blob | MediaSource) => {
				blobs.push(b as Blob);
				return "blob:mock";
			},
		);
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		const panel = runMockSession();
		panel
			.querySelector<HTMLElement>('[data-testid="ingest-export-csv"]')
			?.click();

		expect(blobs).toHaveLength(1);
		expect((blobs[0] as Blob).type).toBe("text/csv");
		const csv = await (blobs[0] as Blob).text();
		expect(csv).toContain("peak_bitrate_kbps,8000");
		expect(csv).toContain("avg_bitrate_kbps,6000");
		expect(csv).toContain("drop_count,1");
		expect(csv).toContain("eth0,100");
		expect(csv).toContain("wlan0,50");
	});

	it("revokes the object URL after a successful download (no leak)", () => {
		vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mock");
		const revoke = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		const panel = runMockSession();
		panel
			.querySelector<HTMLElement>('[data-testid="ingest-export-json"]')
			?.click();

		// The exact URL handed out by createObjectURL must be revoked once.
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith("blob:mock");
		// Happy path never raises the inline error notice.
		expect(
			panel.querySelector('[data-testid="ingest-export-error"]'),
		).toBeNull();
	});
});

/**
 * Sparkline recompute memoization (Task 19).
 *
 * The audit flagged the SVG sparkline being rebuilt on every telemetry tick. The
 * per-link view (path string + trend + health) is now memoized per conn_id keyed
 * on the *identity* of the samples buffer (`createLinkViewCache`). An unchanged
 * buffer is a memo hit (no path rebuild); a genuinely new sample swaps the array
 * reference and forces exactly one recompute. Data correctness is untouched — the
 * cache's input is still the true last-60-sample window.
 */
function sample(rtt: number): Sample {
	return { rtt, nak: 0, weight: 100 };
}

describe("IngestStats — sparkline recompute memoization (Task 19)", () => {
	it("recomputes a conn_id view only when its samples buffer changes", () => {
		const cache = createLinkViewCache();
		const samples = [sample(10), sample(20), sample(30)];

		const N = 50;
		let lastPoints = "";
		for (let i = 0; i < N; i++) {
			lastPoints = cache.get("0", samples).points;
		}
		expect(cache.computeCount).toBe(1);
		expect(lastPoints).toBe(sparkPoints(samples.map((s) => s.rtt)));

		const grown = [...samples, sample(40)];
		cache.get("0", grown);
		expect(cache.computeCount).toBe(2);

		for (let i = 0; i < 20; i++) cache.get("0", grown);
		expect(cache.computeCount).toBe(2);
	});

	it("memoizes each conn_id independently", () => {
		const cache = createLinkViewCache();
		const a = [sample(10), sample(11)];
		const b = [sample(20), sample(21)];

		cache.get("0", a);
		cache.get("1", b);
		expect(cache.computeCount).toBe(2);

		for (let i = 0; i < 30; i++) {
			cache.get("0", a);
			cache.get("1", b);
		}
		expect(cache.computeCount).toBe(2);

		cache.get("0", [...a, sample(12)]);
		expect(cache.computeCount).toBe(3);
	});

	it("derives the path from the latest 60-sample window", () => {
		const all = Array.from({ length: 70 }, (_, i) => sample(i));
		const window = all.slice(-60);

		const view = computeLinkView(window);
		expect(view.count).toBe(60);

		const vertices = view.points.trim().split(/\s+/).filter(Boolean);
		expect(vertices).toHaveLength(60);

		// rtt is normalised over the window's own min/max: oldest retained (rtt=10,
		// the min) draws at the bottom (y≈SPARK_H=24); newest (rtt=69, the max) at
		// the top (y≈0).
		const firstY = Number((vertices[0] as string).split(",")[1]);
		const lastY = Number(
			(vertices[vertices.length - 1] as string).split(",")[1],
		);
		expect(firstY).toBeCloseTo(24, 1);
		expect(lastY).toBeCloseTo(0, 1);
	});

	it("renders the memoized path verbatim — no visual drift after extraction", async () => {
		const { container, rerender } = render(IngestStats, {
			props: { telemetry: oneLink(10) },
		});
		flushSync();
		const rtts = [10, 11, 12, 13, 14];
		for (let i = 1; i < rtts.length; i++) {
			await rerender({ telemetry: oneLink(rtts[i] as number) });
			flushSync();
		}

		const rendered = sparklineOf(container)
			.querySelector("polyline")
			?.getAttribute("points");
		expect(rendered).toBe(
			computeLinkView(rtts.map((rtt) => sample(rtt))).points,
		);
	});
});

/**
 * Export-failure handling (Task 18).
 *
 * A device-local export can fail when the browser refuses to mint an object URL
 * or build the Blob (storage pressure, sandboxed context). The guarded path must
 * degrade calmly: surface the i18n'd inline notice, never let the throw escape
 * the click handler, never leak a URL, and keep the panel interactive so the
 * operator can retry.
 */
describe("IngestStats — export failure handling (Task 18)", () => {
	beforeEach(() => {
		if (typeof URL.createObjectURL !== "function") {
			(URL as unknown as { createObjectURL: () => string }).createObjectURL =
				() => "blob:stub";
		}
		if (typeof URL.revokeObjectURL !== "function") {
			(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
				() => {};
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows the inline error notice when createObjectURL throws (no uncaught)", () => {
		vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
			throw new Error("object-url unavailable");
		});
		const revoke = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		const panel = runMockSession();
		const jsonBtn = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-export-json"]',
		);
		expect(jsonBtn, "export json button must render").not.toBeNull();

		// The click handler must swallow the failure — no exception escapes here.
		expect(() => jsonBtn?.click()).not.toThrow();
		flushSync();

		const notice = panel.querySelector('[data-testid="ingest-export-error"]');
		expect(notice, "export-error notice must surface").not.toBeNull();
		expect(notice?.getAttribute("role")).toBe("alert");
		expect(notice?.textContent?.trim()).not.toBe("");

		// createObjectURL threw before returning a URL, so nothing to revoke.
		expect(revoke).not.toHaveBeenCalled();

		// The panel stays interactive: both export buttons remain mounted.
		expect(
			panel.querySelector('[data-testid="ingest-export-json"]'),
		).not.toBeNull();
		expect(
			panel.querySelector('[data-testid="ingest-export-csv"]'),
		).not.toBeNull();
	});

	it("shows the inline error notice when Blob construction throws", () => {
		const RealBlob = globalThis.Blob;
		vi.spyOn(globalThis, "Blob").mockImplementation((() => {
			throw new Error("blob construction failed");
		}) as unknown as typeof Blob);
		const createUrl = vi.spyOn(URL, "createObjectURL");

		const panel = runMockSession();
		const csvBtn = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-export-csv"]',
		);
		expect(() => csvBtn?.click()).not.toThrow();
		flushSync();

		expect(
			panel.querySelector('[data-testid="ingest-export-error"]'),
		).not.toBeNull();
		// Failure happened before the object URL was minted.
		expect(createUrl).not.toHaveBeenCalled();

		// Restore Blob so other suites in the file are unaffected.
		(globalThis as unknown as { Blob: typeof Blob }).Blob = RealBlob;
	});

	it("clears the error notice once a later export succeeds", () => {
		const createUrl = vi.spyOn(URL, "createObjectURL");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

		const panel = runMockSession();
		const jsonBtn = panel.querySelector<HTMLElement>(
			'[data-testid="ingest-export-json"]',
		);

		// First attempt fails → notice appears.
		createUrl.mockImplementationOnce(() => {
			throw new Error("transient failure");
		});
		jsonBtn?.click();
		flushSync();
		expect(
			panel.querySelector('[data-testid="ingest-export-error"]'),
		).not.toBeNull();

		// Second attempt succeeds → notice clears (panel recovered).
		createUrl.mockImplementation(() => "blob:mock");
		jsonBtn?.click();
		flushSync();
		expect(
			panel.querySelector('[data-testid="ingest-export-error"]'),
		).toBeNull();
	});
});
