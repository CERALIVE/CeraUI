import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Telemetry lifecycle end-to-end gate (ceraui-experience-simplification, Todo 22).
 *
 * Proves the "telemetry-clears-on-stop" contract against the REAL Svelte app +
 * dev mock backend, driven entirely through injected WebSocket frames (no new
 * mock backend flag, per PLAYBOOK). The mechanism is the SAME `routeWebSocket`
 * proxy the truthfulness / source-overhaul specs use:
 *
 *   • the proxy forwards auth + RPC traffic to the real backend untouched;
 *   • it rewrites every server→client `status` frame's `is_streaming` to a
 *     test-owned flag and STRIPS its `linkTelemetry` (srtla_send never runs under
 *     the mock, so the backend's own frames carry `linkTelemetry:null`) — leaving
 *     the injected frames as the sole, deterministic source of streaming state
 *     AND telemetry;
 *   • every INJECTED frame carries a monotonically-increasing `seq` from a large
 *     base, so it wins over any backend `status` frame AND the per-type seq guard
 *     (subscriptions.svelte.ts) drops a deliberately STALE-seq frame — the
 *     rendered-DOM proof of the drop-stale rule.
 *
 * The three lifecycle facts asserted, end-to-end:
 *   1. streaming + telemetry → IngestStats live rows render + the persistent HUD
 *      shows a real bitrate (never a stale value, never a dash);
 *   2. stop (`is_streaming:false` + `linkTelemetry:null`) → the live rows vanish,
 *      the HUD bitrate collapses to "—", AND the bounded post-stream summary
 *      window (LiveView `showingSummary`, the just-landed reachability fix) keeps
 *      IngestStats mounted long enough to render its "Session ended · …" summary;
 *   3. a stale-seq telemetry frame injected AFTER stop is dropped — the cleared
 *      UI stays cleared (drop-stale proven through the rendered DOM).
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only — no pixel
 * capture, no fixed-delay waits, no hardcoded nav-tab selectors.
 */

type TelemetryEntry = {
	conn_id: string;
	iface: string;
	rtt_ms: number;
	nak_count: number;
	weight_percent: number;
	stale: boolean;
};

const TWO_LINKS: TelemetryEntry[] = [
	{ conn_id: "0", iface: "eth0", rtt_ms: 18, nak_count: 2, weight_percent: 60, stale: false },
	{ conn_id: "1", iface: "wlan0", rtt_ms: 47, nak_count: 5, weight_percent: 40, stale: false },
];

// ── Test-owned proxy control state (reset per test in beforeEach) ────────────
let pageWs: WebSocketRoute | null = null;
// Every server→client `status` frame's is_streaming is rewritten to this flag so
// the mock's own idle broadcasts can never flip the streaming state out from
// under a test (a seq-less reconnect-hydrate frame would otherwise bypass the
// seq guard); the injected big-seq frames are still the authoritative driver.
let desiredStreaming = false;
// A large seq base so every injected frame beats the backend's own low `status`
// seq AND advances the per-type guard — which is what makes a later LOWER-seq
// injection a genuine drop-stale case.
const SEQ_BASE = 9_000_000;
let seqCounter = SEQ_BASE;

/** Inject an authoritative `status` frame with the next monotonic seq. */
function pushStatus(payload: Record<string, unknown>): void {
	seqCounter += 1;
	pageWs?.send(JSON.stringify({ status: payload, seq: seqCounter }));
}

/** Inject a `status` frame carrying an EXPLICIT seq (for the drop-stale proof). */
function pushStatusWithSeq(payload: Record<string, unknown>, seq: number): void {
	pageWs?.send(JSON.stringify({ status: payload, seq }));
}

/** Inject a seq-less config frame (bypasses the guard; no backend echo races it). */
function sendConfig(extra: Record<string, unknown> = {}): void {
	pageWs?.send(
		JSON.stringify({
			config: {
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				srt_streamid: "e2e",
				max_br: 6000,
				pipeline: "hdmi",
				...extra,
			},
		}),
	);
}

test.describe("Telemetry lifecycle (clears on stop)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Live cockpit + persistent HUD; mobile/kiosk are the @visual suite",
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
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status && typeof frame.status === "object") {
						// Keep streaming state test-owned and telemetry injected-only.
						frame.status.is_streaming = desiredStreaming;
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

	// The visible persistent HUD bitrate chip (role="img", aria-label "Bitrate: …").
	function hudBitrate(page: import("@playwright/test").Page) {
		return page
			.locator("[data-hud-region]")
			.filter({ visible: true })
			.first()
			.getByRole("img", { name: /bitrate/i });
	}

	test("streaming telemetry renders live rows + a real HUD bitrate, and a real stop clears both and shows the session-ended summary", async ({
		page,
	}) => {
		sendConfig();

		// ── 1. Streaming + telemetry ───────────────────────────────────────────
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		const rows = panel.getByTestId("ingest-row");
		await expect(rows).toHaveCount(2);
		await expect(panel.getByTestId("ingest-total-weight")).toHaveText("100%");

		// The persistent HUD shows a real, live bitrate (never a stale number, never
		// a dash) while streaming with a configured ceiling.
		const bitrate = hudBitrate(page);
		await expect(bitrate).toBeVisible();
		await expect(bitrate).toContainText(/Mbps|Kbps/);
		await expect(bitrate).not.toContainText("—");

		// ── 2. Real stop: is_streaming false + linkTelemetry null ──────────────
		desiredStreaming = false;
		pushStatus({ is_streaming: false, linkTelemetry: null });

		// The live per-link rows vanish (the summary branch replaces them).
		await expect(panel.getByTestId("ingest-row")).toHaveCount(0);

		// The post-stream summary window keeps IngestStats mounted long enough to
		// fold + render its historical "Session ended · …" summary (the just-landed
		// reachability fix — proven here end-to-end, no source change).
		await expect(panel.getByTestId("ingest-summary")).toBeVisible();
		await expect(panel).toContainText(/session ended/i);

		// The HUD bitrate collapses to the honest absence dash once streaming stops.
		await expect(hudBitrate(page)).toContainText("—");
	});

	test("a stale-seq telemetry frame injected after stop is dropped — the cleared UI stays cleared", async ({
		page,
	}) => {
		sendConfig();

		// Establish a live session so a rollup exists to fold, then stop it.
		desiredStreaming = true;
		const liveSeq = seqCounter + 1;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		const panel = page.getByTestId("ingest-stats");
		await expect(panel.getByTestId("ingest-row")).toHaveCount(2, { timeout: 15_000 });

		desiredStreaming = false;
		pushStatus({ is_streaming: false, linkTelemetry: null });
		await expect(panel.getByTestId("ingest-row")).toHaveCount(0);
		await expect(panel.getByTestId("ingest-summary")).toBeVisible();

		// A STALE-seq telemetry frame (seq below the last-applied stop frame) is
		// dropped by the per-type seq guard — the cleared UI must NOT resurrect the
		// live rows or a HUD bitrate. This is the drop-stale rule, end-to-end.
		pushStatusWithSeq(
			{ is_streaming: true, linkTelemetry: { links: TWO_LINKS } },
			liveSeq,
		);

		// Give the (dropped) frame a chance to be processed, then assert nothing
		// changed: still no live rows, summary still shown, HUD still dashed.
		await expect(panel.getByTestId("ingest-row")).toHaveCount(0);
		await expect(panel.getByTestId("ingest-summary")).toBeVisible();
		await expect(hudBitrate(page)).toContainText("—");
	});
});
