import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Summary-coherence transport gate (live-correctness-pass Todo 12).
 *
 * Proves the "one transport token per idle surface" contract against the REAL
 * Svelte app + dev mock backend, driven through the SAME `routeWebSocket` proxy
 * the telemetry-stop / truthfulness specs use (every server->client `status`
 * frame's `is_streaming` is rewritten to a test-owned flag; injected big-seq
 * frames are the authoritative streaming driver):
 *
 *   1. IDLE: the string `SRTLA` appears in EXACTLY ONE region of the idle cockpit
 *      DOM — the Destination/server row — and never in the encoder row or the
 *      Source card's active-config line.
 *   2. LIVE (regression guard): while streaming, the "Now streaming" summary strip
 *      STILL shows the transport token (`SRTLA`) — the idle declutter must NOT
 *      over-delete transport from the live surface.
 */

let pageWs: WebSocketRoute | null = null;
let desiredStreaming = false;
const SEQ_BASE = 9_000_000;
let seqCounter = SEQ_BASE;

function pushStatus(payload: Record<string, unknown>): void {
	seqCounter += 1;
	pageWs?.send(JSON.stringify({ status: payload, seq: seqCounter }));
}

test.describe("Live summary transport coherence (Todo 12)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Live idle/live cockpit; mobile/kiosk are the @visual suite",
		);

		pageWs = null;
		desiredStreaming = false;
		seqCounter = SEQ_BASE;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						status?: Record<string, unknown>;
					};
					if (frame?.status && typeof frame.status === "object") {
						frame.status.is_streaming = desiredStreaming;
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

	test("idle: SRTLA appears in exactly one region of the idle cockpit — the destination row", async ({
		page,
	}) => {
		const idle = page.getByTestId("idle-cockpit");
		await expect(idle).toBeVisible({ timeout: 15_000 });

		// Establish a KNOWN idle config over the socket rather than depending on the
		// backend's on-disk config.json (which the dev reference backend mutates, so it
		// is non-deterministic locally). A custom SRTLA endpoint makes the server row
		// render "SRTLA · Custom" (destination gate satisfied by srtla_addr), and a
		// source makes the Source card's active-config line render at all (its
		// `hasActiveConfig` gate needs a source/resolution/codec) — this test asserts
		// SRTLA does NOT leak into that line, which is only meaningful when it renders.
		// The frame merges field-by-field (config case); no field-lock is held on a
		// fresh navigation, so the injected values win.
		pageWs?.send(
			JSON.stringify({
				config: {
					relay_server: "",
					selected_ingest_endpoint: "",
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					srt_streamid: "e2e",
					relay_protocol: "srtla",
					source: "cam-0",
				},
			}),
		);
		const activeConfig = idle.getByTestId("active-config-value");
		await expect(activeConfig).toBeVisible();

		// The Destination/server row is the single idle surface that names the transport.
		await expect(idle.locator('[data-section="server"]')).toContainText("SRTLA");

		// The encoder row and the Source card's active-config line no longer carry it.
		await expect(idle.locator('[data-section="encoder"]')).not.toContainText(
			"SRTLA",
		);
		await expect(activeConfig).not.toContainText("SRTLA");

		// QA: the innermost text-bearing element carrying SRTLA is exactly one — the
		// server row's summary line. getByText returns the smallest matching element,
		// so nested wrappers are never double-counted.
		await expect(idle.getByText("SRTLA", { exact: false })).toHaveCount(1);
	});

	test("live: the Now-streaming strip still shows the transport token", async ({
		page,
	}) => {
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: null });

		const strip = page.getByTestId("live-summary-strip");
		await expect(strip).toBeVisible({ timeout: 15_000 });
		await expect(strip.locator('[data-live-value="transport"]')).toHaveText(
			"SRTLA",
		);
	});
});
