import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the ingest historical-trends feature.
 *
 * srtla_send never runs under the mock, so the backend's status frames carry
 * `linkTelemetry:null` and `is_streaming:false`. The WS proxy below forces
 * `is_streaming:true` (so the streaming-only IngestStats panel mounts) and strips
 * the null `linkTelemetry`, leaving the injected, seq-less frames as the sole
 * source. Each injected frame is delivered as its own onmessage event, so the
 * panel's ring-buffer effect appends exactly one sample per frame.
 *
 * Two PNGs land in CeraUI/test-results/ (repo-local, gitignored): one of the
 * per-link sparklines under stable latency, one of the degradation alert after a
 * rising-RTT ramp crosses the threshold. Tagged @visual so the screenshot guard
 * in fixtures/index.ts permits element screenshots here.
 */

type TelemetryEntry = {
	conn_id: string;
	iface: string;
	rtt_ms: number;
	nak_count: number;
	weight_percent: number;
	stale: boolean;
};

// CeraUI repo root is five levels up from tests/e2e/visual.
const REPO_TEST_RESULTS = path.resolve(import.meta.dirname, "../../../../../test-results");

test.describe("@visual ingest historical trends", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser visual evidence",
	);

	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }, testInfo) => {
		// One run only: both projects are chromium, and the screenshots write to
		// fixed paths, so the desktop viewport owns the evidence to avoid a race.
		test.skip(testInfo.project.name !== "desktop", "desktop viewport owns evidence");
		pageWs = null;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status) {
						frame.status.is_streaming = true;
						delete frame.status.linkTelemetry;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	function buildFrame(rtt: number, nak: number): TelemetryEntry[] {
		return [
			{ conn_id: "0", iface: "eth0", rtt_ms: rtt, nak_count: nak, weight_percent: 60, stale: false },
			{
				conn_id: "1",
				iface: "wlan0",
				rtt_ms: Math.round(rtt * 1.4),
				nak_count: nak,
				weight_percent: 40,
				stale: false,
			},
		];
	}

	// Deliver one telemetry frame and yield a tick so the client processes it as a
	// discrete onmessage (one ring sample), not a batched update.
	async function feed(page: Page, rtt: number, nak: number): Promise<void> {
		pageWs?.send(
			JSON.stringify({
				status: { is_streaming: true, linkTelemetry: { links: buildFrame(rtt, nak) } },
			}),
		);
		await page.evaluate(() => new Promise((r) => setTimeout(r, 6)));
	}

	test("per-link sparklines render under stable latency", { tag: "@visual" }, async ({ page }) => {
		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Mild jitter around a steady baseline: enough vertices for a visible trace.
		const baseline = [18, 20, 19, 21, 20, 18, 22, 20, 19, 21, 20, 19, 21, 20, 18, 20];
		for (let i = 0; i < baseline.length; i++) {
			await feed(page, baseline[i] as number, i);
		}

		const spark = panel.locator('[data-testid="ingest-sparkline"][data-iface="eth0"]');
		await expect
			.poll(async () => Number(await spark.getAttribute("data-samples")), { timeout: 10_000 })
			.toBeGreaterThanOrEqual(12);
		await expect(spark.locator("polyline")).toHaveCount(1);
		await expect(panel.getByTestId("ingest-alert")).toHaveCount(0);

		await panel.screenshot({ path: path.join(REPO_TEST_RESULTS, "ingest-sparkline.png") });
	});

	test("degradation alert fires on a rising-RTT ramp", { tag: "@visual" }, async ({ page }) => {
		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Leading window ~20 ms, trailing window ~80 ms: trail avg > 2× lead avg.
		const lead = Array.from({ length: 11 }, () => 20);
		const trail = Array.from({ length: 12 }, () => 80);
		const ramp = [...lead, ...trail];
		for (let i = 0; i < ramp.length; i++) {
			await feed(page, ramp[i] as number, i);
		}

		const alert = panel.getByTestId("ingest-alert");
		await expect(alert).toBeVisible({ timeout: 10_000 });
		await expect(
			panel.locator('[data-testid="ingest-health"][data-iface="eth0"]'),
		).toHaveAttribute("data-status", "degraded");

		await panel.screenshot({ path: path.join(REPO_TEST_RESULTS, "ingest-alert.png") });
	});
});
