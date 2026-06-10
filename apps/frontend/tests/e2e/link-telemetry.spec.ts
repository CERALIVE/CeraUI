import fs from "node:fs";
import path from "node:path";

import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Task 22 — per-link RTT / NAK / weight telemetry in NetworkView.
 *
 * Proves the four observable states of the bonded-link telemetry row against
 * the real dev stack (frontend :6173 + mock backend :3002,
 * MOCK_SCENARIO=multi-modem-wifi):
 *
 *   1. Happy path — inject linkTelemetry for a live card; RTT/NAK/weight render.
 *   2. Update flow — push a new RTT; the value re-renders within 2 s.
 *   3. Empty state — linkTelemetry:null; every value reads "--", card height
 *      is identical to the populated state (layout-stable).
 *   4. Stale state — entry.stale:true; the telemetry row dims + earns a marker.
 *   5. Sender constants — rtt_ms:0 / weight_percent:100 render as-is (valid,
 *      not sentinels).
 *
 * srtla_send is never running under the mock, so the backend's own status frames
 * carry `linkTelemetry:null`. The WS proxy strips that field from every
 * server→client frame, leaving the injected (seq-less, drop-stale-bypassing)
 * frames as the sole source of telemetry — fully deterministic.
 */

type TelemetryEntry = {
	conn_id: string;
	iface: string;
	rtt_ms: number;
	nak_count: number;
	weight_percent: number;
	stale: boolean;
};

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
	console.log(`[task-22-ui] ${line}`);
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			"Task 22 — per-link RTT/NAK/weight telemetry in NetworkView",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

test.describe("Task 22 — link telemetry", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the bonded-link cards",
		);
		pageWs = null;

		// Proxy the WS: forward everything, but drop the backend's own
		// `linkTelemetry` (always null under the mock) so injected frames win.
		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						status?: Record<string, unknown>;
					};
					if (frame?.status && "linkTelemetry" in frame.status) {
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
		await navigateTo(page, "network");
	});

	/** Inject a `status` frame carrying linkTelemetry (seq-less → bypasses guard). */
	function pushTelemetry(links: TelemetryEntry[] | null): void {
		pageWs?.send(JSON.stringify({ status: { linkTelemetry: links === null ? null : { links } } }));
	}

	/** The first visible bonded-link card + its resolved interface id. */
	async function firstCard(page: import("@playwright/test").Page) {
		const card = page.locator('[data-testid="bonded-link-card"]:visible').first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		const iface = await card.getAttribute("data-link-id");
		expect(iface, "card must expose its interface id").toBeTruthy();
		return { card, iface: iface as string };
	}

	test("happy path: injected RTT/NAK/weight render on the live card", async ({
		page,
	}) => {
		const { card, iface } = await firstCard(page);
		record(`live card iface=${iface}`);

		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 42, nak_count: 3, weight_percent: 85, stale: false },
		]);

		await expect(card.getByTestId("link-rtt")).toHaveText("42 ms");
		await expect(card.getByTestId("link-nak")).toHaveText("3");
		await expect(card.getByTestId("link-weight")).toHaveText("85%");
		await expect(card.getByTestId("link-telemetry")).toHaveAttribute(
			"data-stale",
			"false",
		);
		record("rendered RTT=42 ms, NAK=3, weight=85% (not stale) ✓");

		writeEvidence("task-22-ui-happy.txt", [
			"State 1 — happy path",
			...evidence,
			"",
			"Result: PASS — live values rendered with correct units.",
		]);
	});

	test("update flow: a new RTT propagates to the card within 2 s", async ({
		page,
	}) => {
		const { card, iface } = await firstCard(page);

		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 42, nak_count: 3, weight_percent: 85, stale: false },
		]);
		await expect(card.getByTestId("link-rtt")).toHaveText("42 ms");
		record("baseline RTT=42 ms");

		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 55, nak_count: 4, weight_percent: 85, stale: false },
		]);
		await expect(card.getByTestId("link-rtt")).toHaveText("55 ms", { timeout: 2_000 });
		await expect(card.getByTestId("link-nak")).toHaveText("4");
		record("RTT updated 42 → 55 ms and NAK 3 → 4 within 2 s ✓");

		writeEvidence("task-22-ui-update.txt", [
			"State 2 — update flow",
			...evidence,
			"",
			"Result: PASS — value changes propagate ≤2 s.",
		]);
	});

	test("empty state: null telemetry shows -- with a layout-stable card", async ({
		page,
	}) => {
		const { card, iface } = await firstCard(page);

		// Empty: every value is a placeholder; record the card height.
		pushTelemetry(null);
		await expect(card.getByTestId("link-rtt")).toHaveText("--");
		await expect(card.getByTestId("link-nak")).toHaveText("--");
		await expect(card.getByTestId("link-weight")).toHaveText("--");
		const empty = await card.boundingBox();
		expect(empty).not.toBeNull();
		record(`empty: RTT/NAK/weight = "--"; card height=${empty?.height}`);

		// Populate: same DOM structure, values swapped in.
		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 42, nak_count: 3, weight_percent: 85, stale: false },
		]);
		await expect(card.getByTestId("link-rtt")).toHaveText("42 ms");
		const filled = await card.boundingBox();
		expect(filled).not.toBeNull();
		record(`filled: values present; card height=${filled?.height}`);

		const delta = Math.abs((filled?.height ?? 0) - (empty?.height ?? 0));
		expect(Math.round(delta)).toBe(0);
		record(`height delta empty→filled = ${delta}px (== 0) ✓`);

		writeEvidence("task-22-ui-empty.txt", [
			"State 3 — empty / layout stability",
			...evidence,
			"",
			"Result: PASS — placeholders shown; no height shift when data appears.",
		]);
	});

	test("stale state: stale telemetry dims the row and shows a marker", async ({
		page,
	}) => {
		const { card, iface } = await firstCard(page);

		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 42, nak_count: 3, weight_percent: 85, stale: true },
		]);

		// Values still present (last-known) but the row is marked + dimmed.
		await expect(card.getByTestId("link-rtt")).toHaveText("42 ms");
		const dl = card.getByTestId("link-telemetry");
		await expect(dl).toHaveAttribute("data-stale", "true");
		const opacity = await dl.evaluate((el) => getComputedStyle(el).opacity);
		expect(Number(opacity)).toBeLessThan(1);
		await expect(card.locator(`[data-stale-interface="${iface}"]`)).toBeVisible();
		record(`stale row: opacity=${opacity}, stale marker present for ${iface} ✓`);

		writeEvidence("task-22-ui-stale.txt", [
			"State 4 — stale",
			...evidence,
			"",
			"Result: PASS — aged telemetry dimmed + marked, last value retained.",
		]);
	});

	test("sender constants: rtt_ms=0 and weight_percent=100 render as-is", async ({
		page,
	}) => {
		const { card, iface } = await firstCard(page);

		pushTelemetry([
			{ conn_id: "0", iface, rtt_ms: 0, nak_count: 0, weight_percent: 100, stale: false },
		]);

		await expect(card.getByTestId("link-rtt")).toHaveText("0 ms");
		await expect(card.getByTestId("link-nak")).toHaveText("0");
		await expect(card.getByTestId("link-weight")).toHaveText("100%");
		record("rtt_ms=0 → '0 ms', weight_percent=100 → '100%' (valid, not '--') ✓");

		writeEvidence("task-22-ui-constants.txt", [
			"State 5 — sender constants",
			...evidence,
			"",
			"Result: PASS — zero RTT and 100% weight shown literally.",
		]);
	});
});
