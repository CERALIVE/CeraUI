import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the per-session ingest summary + export affordance.
 *
 * srtla_send never runs under the mock, so backend status frames carry
 * `linkTelemetry:null`. The WS proxy below rewrites `is_streaming` from a mutable
 * flag and strips the null telemetry, so injected seq-less frames are the sole
 * source. The test first streams (flag true) and feeds telemetry frames — one of
 * which drops wlan0 — so the panel samples a session; then it flips the flag
 * false and sends an idle frame, driving IngestStats to fold those samples into
 * the end-of-stream summary (peak/avg bitrate, per-link uptime, drop count) with
 * the JSON/CSV export buttons. The PNG lands in CeraUI/test-results/ (repo-local,
 * gitignored). Tagged @visual so the screenshot guard permits it.
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

test.describe("@visual ingest session summary + export", () => {
	let pageWs: WebSocketRoute | null;
	let streaming = true;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop viewport owns evidence");
		pageWs = null;
		streaming = true;

		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status) {
						frame.status.is_streaming = streaming;
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

	function frame(wlan0Stale: boolean): TelemetryEntry[] {
		return [
			{ conn_id: "0", iface: "eth0", rtt_ms: 18, nak_count: 1, weight_percent: 60, stale: false },
			{ conn_id: "1", iface: "wlan0", rtt_ms: 47, nak_count: 3, weight_percent: 40, stale: wlan0Stale },
		];
	}

	// Deliver one streaming telemetry frame as a discrete onmessage (one sample).
	async function feed(page: Page, wlan0Stale: boolean): Promise<void> {
		pageWs?.send(
			JSON.stringify({
				status: { is_streaming: true, linkTelemetry: { links: frame(wlan0Stale) } },
			}),
		);
		await page.evaluate(() => new Promise((r) => setTimeout(r, 6)));
	}

	test(
		"session summary surfaces after the stream stops, with export buttons",
		{ tag: "@visual" },
		async ({ page }) => {
			// Seed a configured server so the Live view never falls back to its
			// empty state when the stream stops (a real streaming session always has
			// a server) — otherwise LiveView's showEmptyState unmounts the panel.
			pageWs?.send(
				JSON.stringify({ config: { srtla_addr: "127.0.0.1", srtla_port: 5000, max_br: 5000 } }),
			);

			const panel = page.getByTestId("ingest-stats");
			await expect(panel).toBeVisible({ timeout: 15_000 });

			// Build a session: wlan0 fresh, then drops (up→down), then fresh again.
			await feed(page, false);
			await feed(page, false);
			await feed(page, true);
			await feed(page, true);
			await feed(page, false);

			// Stop the stream: flip the proxy flag and send an idle frame so the
			// panel folds the samples into its end-of-session summary.
			streaming = false;
			pageWs?.send(JSON.stringify({ status: { is_streaming: false, linkTelemetry: null } }));

			await expect(panel.getByTestId("ingest-summary")).toBeVisible({ timeout: 15_000 });
			await expect(panel.getByTestId("ingest-summary-peak")).toBeVisible();
			await expect(panel.getByTestId("ingest-summary-avg")).toBeVisible();
			await expect(panel.getByTestId("ingest-summary-drops")).toBeVisible();
			await expect(panel.getByTestId("ingest-export-json")).toBeVisible();
			await expect(panel.getByTestId("ingest-export-csv")).toBeVisible();

			await panel.screenshot({
				path: path.join(REPO_TEST_RESULTS, "ingest-summary-export.png"),
			});
		},
	);
});
