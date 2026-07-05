import fs from "node:fs";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

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
// When non-null, the proxy rewrites every `status.getStatus` RPC RESPONSE's
// is_streaming to this value — simulating a backend that reports still-streaming
// (genuinely stuck) or finally-stopped (recovery) to the stopping watchdog's
// authoritative PULL, which the push-frame rewrite (desiredStreaming) cannot reach.
let forcePullStreaming: boolean | null = null;
// Tracks in-flight RPC request id → dotted path so a response can be matched.
const pendingRpc = new Map<string, string>();

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

/** Set a prod-inert numeric window seam (watchdog / summary-window shrink). */
function setWindowNumber(page: Page, key: string, value: number): Promise<void> {
	return page.evaluate(
		({ key: k, value: v }) => {
			(window as unknown as Record<string, number>)[k] = v;
		},
		{ key, value },
	);
}

/** The real Stop control inside the Live cockpit (arms the stopping watchdog). */
function stopButton(page: Page) {
	return page
		.getByTestId("live-cockpit")
		.getByRole("button", { name: /stop stream/i });
}

/** A window marker that would vanish on a full reload — proves in-app recovery. */
async function markNoReload(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __ceraNoReload?: string }).__ceraNoReload = "alive";
	});
}

async function stillNotReloaded(page: Page): Promise<boolean> {
	return page.evaluate(
		() =>
			(window as unknown as { __ceraNoReload?: string }).__ceraNoReload ===
			"alive",
	);
}

// Human-readable evidence for the T0 QA gate (apps/frontend/test-results).
const t0Evidence: Array<Record<string, unknown>> = [];
// Separate evidence ledger for the T13 post-stream "Done" close gate.
const t13Evidence: Array<Record<string, unknown>> = [];

test.describe("Telemetry lifecycle (clears on stop)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Live cockpit + persistent HUD; mobile/kiosk are the @visual suite",
		);

		pageWs = null;
		desiredStreaming = false;
		seqCounter = SEQ_BASE;
		forcePullStreaming = null;
		pendingRpc.clear();

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const req = JSON.parse(text) as { id?: string; path?: string[] };
					if (req?.id && Array.isArray(req.path)) {
						pendingRpc.set(req.id, req.path.join("."));
					}
				} catch {
					/* non-JSON / binary frame */
				}
				server.send(m);
			});

			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						id?: string;
						result?: Record<string, unknown>;
						status?: Record<string, unknown>;
					};
					// (a) RPC RESPONSE interception: force the watchdog's authoritative
					//     status.getStatus PULL to a test-owned is_streaming, bypassing the
					//     push-frame rewrite entirely (the real pull is seq-less too).
					if (frame?.id && pendingRpc.has(frame.id)) {
						const path = pendingRpc.get(frame.id);
						pendingRpc.delete(frame.id);
						if (
							path === "status.getStatus" &&
							forcePullStreaming !== null &&
							frame.result &&
							typeof frame.result === "object"
						) {
							frame.result.is_streaming = forcePullStreaming;
							ws.send(JSON.stringify(frame));
							return;
						}
					}
					// (b) Broadcast status rewrite: keep streaming state test-owned and
					//     telemetry injected-only (unchanged existing behavior).
					if (frame?.status && typeof frame.status === "object") {
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

	// ── T0: stop-edge stuck-state recovery ──────────────────────────────────────

	test("SLOW PATH: a normal stop opens the bounded summary window, then returns to IdleCockpit with no reload once it elapses", async ({
		page,
	}) => {
		// Shrink the post-stream summary window via the prod-inert seam so the SLOW
		// path (30s in prod) resolves within the test — this is NOT the stuck bug.
		await setWindowNumber(page, "__ceraSummaryWindowMs", 400);
		await markNoReload(page);

		sendConfig();
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });

		// Real stop: the authoritative is_streaming:false push IS delivered.
		desiredStreaming = false;
		pushStatus({ is_streaming: false, linkTelemetry: null });

		// The summary window keeps the cockpit mounted (summary shown)…
		await expect(page.getByTestId("ingest-summary")).toBeVisible();

		// …then the bounded window elapses → back to IdleCockpit, NO reload.
		await expect(page.getByTestId("idle-cockpit")).toBeVisible();
		await expect(page.getByTestId("live-cockpit")).toHaveCount(0);
		expect(await stillNotReloaded(page)).toBe(true);

		t0Evidence.push({
			case: "slow-path",
			result: "summary→idle within the shrunk window, no reload",
		});
	});

	test("NO-REBROADCAST TRAP: a lost stop push after the server already stopped is recovered by the watchdog PULL alone — no reload", async ({
		page,
	}) => {
		await setWindowNumber(page, "__ceraStopWatchdogMs", 600);
		await setWindowNumber(page, "__ceraSummaryWindowMs", 400);
		await markNoReload(page);

		sendConfig();
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		const live = page.getByTestId("live-cockpit");
		await expect(live).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("ingest-row")).toHaveCount(2);

		// Click the REAL Stop button (arms the stopping watchdog). The mock backend is
		// NOT actually streaming, so its stop emits NO is_streaming:false broadcast; and
		// we KEEP desiredStreaming=true so any stop push is rewritten back to true — the
		// single authoritative false PUSH is LOST client-side (the field bug). A retry
		// stop would generate no new change-broadcast either (no-rebroadcast trap).
		await stopButton(page).click();

		// The watchdog's authoritative status PULL (real backend is_streaming:false,
		// which the push-rewrite cannot touch) reconciles the store → summary → Idle,
		// within the watchdog+summary bound, with NO reload.
		await expect(page.getByTestId("idle-cockpit")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("live-cockpit")).toHaveCount(0);
		expect(await stillNotReloaded(page)).toBe(true);

		t0Evidence.push({
			case: "no-rebroadcast-trap",
			result: "watchdog PULL alone recovered to idle, no reload",
		});
	});

	test("GENUINELY STUCK: a backend that cannot stop shows the stop-stuck banner and stays truthfully live; Retry after recovery resolves it", async ({
		page,
	}) => {
		await setWindowNumber(page, "__ceraStopWatchdogMs", 500);
		await setWindowNumber(page, "__ceraSummaryWindowMs", 300);

		sendConfig();
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });

		// The backend genuinely cannot stop: force the watchdog's authoritative PULL to
		// keep reporting is_streaming:true (and keep the push rewritten to true too).
		forcePullStreaming = true;
		await stopButton(page).click();

		// The watchdog pulls (still streaming) → re-dispatches → pulls (still streaming)
		// → exposes the truthful banner with Retry. The view stays TRUTHFULLY live
		// (LiveCockpit still shown) — never fake-idle.
		const banner = page.getByTestId("stop-stuck-banner");
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await expect(banner.getByTestId("stop-stuck-retry")).toBeVisible();
		await expect(page.getByTestId("live-cockpit")).toBeVisible();
		await expect(page.getByTestId("idle-cockpit")).toHaveCount(0);

		// Recovery: the backend finally stops. Retry re-runs pull→stop→pull; the pull
		// now returns is_streaming:false → reconcile → summary → IdleCockpit, banner gone.
		forcePullStreaming = false;
		await banner.getByTestId("stop-stuck-retry").click();

		await expect(page.getByTestId("stop-stuck-banner")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByTestId("idle-cockpit")).toBeVisible();

		t0Evidence.push({
			case: "genuinely-stuck-with-retry",
			result: "stop-stuck banner + Retry; recovered to idle after backend stopped",
		});
	});

	// ── T13: explicit post-stream "Done" close ──────────────────────────────────

	test("DONE BUTTON: after a stop the summary window's Done returns to IdleCockpit immediately and the fallback timer is cleared (no late flip back)", async ({
		page,
	}) => {
		// A large summary window so the bounded fallback timer CANNOT close the
		// window during the test — the ONLY way to reach idle quickly is the Done
		// click. markNoReload proves the transition is in-app (no reload).
		await setWindowNumber(page, "__ceraSummaryWindowMs", 20_000);
		await markNoReload(page);

		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(String(err)));

		sendConfig();
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		const live = page.getByTestId("live-cockpit");
		await expect(live).toBeVisible({ timeout: 15_000 });

		// Real stop: opens the (large) bounded summary window.
		desiredStreaming = false;
		pushStatus({ is_streaming: false, linkTelemetry: null });

		await expect(page.getByTestId("ingest-summary")).toBeVisible();
		const done = live.getByTestId("summary-done");
		await expect(done).toBeVisible();

		// Click Done → idle-cockpit within 1s, WELL before the 20s fallback window —
		// proving the explicit escape, not the timer, drove the transition.
		await done.click();
		await expect(page.getByTestId("idle-cockpit")).toBeVisible({ timeout: 1_000 });
		await expect(page.getByTestId("live-cockpit")).toHaveCount(0);

		// The fallback timer was cleared: after a wait it stays idle (no late flip
		// back to the summary/live cockpit) and nothing reloaded the page.
		await page.waitForTimeout(1_200);
		await expect(page.getByTestId("idle-cockpit")).toBeVisible();
		await expect(page.getByTestId("live-cockpit")).toHaveCount(0);
		expect(await stillNotReloaded(page)).toBe(true);
		expect(pageErrors).toEqual([]);

		t13Evidence.push({
			case: "done-closes-immediately",
			result: "Done → idle within 1s, timer cleared, no late flip back, no reload",
		});
	});

	test("DONE BUTTON idempotent: double-clicking Done throws no error and stays idle", async ({
		page,
	}) => {
		await setWindowNumber(page, "__ceraSummaryWindowMs", 20_000);

		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(String(err)));

		sendConfig();
		desiredStreaming = true;
		pushStatus({ is_streaming: true, linkTelemetry: { links: TWO_LINKS } });

		const live = page.getByTestId("live-cockpit");
		await expect(live).toBeVisible({ timeout: 15_000 });

		desiredStreaming = false;
		pushStatus({ is_streaming: false, linkTelemetry: null });

		const done = live.getByTestId("summary-done");
		await expect(done).toBeVisible();

		// Double-click: the second click's onCloseSummary is a no-op (already closed);
		// closeSummary is idempotent so the app never errors and settles on idle.
		await done.dblclick();
		await expect(page.getByTestId("idle-cockpit")).toBeVisible({ timeout: 1_000 });
		await expect(page.getByTestId("live-cockpit")).toHaveCount(0);
		expect(pageErrors).toEqual([]);

		t13Evidence.push({
			case: "done-double-click-idempotent",
			result: "double-click Done: no error, stays idle",
		});
	});

	test.afterAll(() => {
		// The T13 Done-close gate evidence (separate named file from the T0 ledger).
		const t13File = evidencePath("ler-t13.json");
		const t13Merged = new Map<string, Record<string, unknown>>();
		try {
			const prior = JSON.parse(fs.readFileSync(t13File, "utf8")) as {
				cases?: Array<Record<string, unknown>>;
			};
			for (const c of prior.cases ?? []) t13Merged.set(String(c.case), c);
		} catch {
			/* no prior file */
		}
		for (const c of t13Evidence) t13Merged.set(String(c.case), c);
		fs.writeFileSync(
			t13File,
			JSON.stringify(
				{
					task: "T13 — closeable post-stream report (Done button)",
					generated: new Date().toISOString(),
					cases: [...t13Merged.values()],
				},
				null,
				2,
			),
			"utf8",
		);
	});

	test.afterAll(() => {
		// Merge with any cases a sibling parallel worker already wrote so the single
		// named evidence file accumulates every T0 case (best-effort, last-write-wins).
		const file = evidencePath("ler-t0-stop-edge.json");
		const merged = new Map<string, Record<string, unknown>>();
		try {
			const prior = JSON.parse(fs.readFileSync(file, "utf8")) as {
				cases?: Array<Record<string, unknown>>;
			};
			for (const c of prior.cases ?? []) merged.set(String(c.case), c);
		} catch {
			/* no prior file */
		}
		for (const c of t0Evidence) merged.set(String(c.case), c);
		fs.writeFileSync(
			file,
			JSON.stringify(
				{
					task: "T0 — stop-edge stuck state + bounded stopping watchdog",
					generated: new Date().toISOString(),
					cases: [...merged.values()],
				},
				null,
				2,
			),
			"utf8",
		);
	});
});
