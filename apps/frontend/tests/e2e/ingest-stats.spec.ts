import fs from "node:fs";
import path from "node:path";

import type { LinkTelemetryMessage, ModemList, NetifMessage } from "@ceraui/rpc/schemas";
import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo, openLiveDetails } from "./helpers/index.js";

/**
 * Task 21 — bonded-ingest telemetry panel on the Live destination.
 *
 * The IngestStats panel reads the SAME `status.linkTelemetry` feed that already
 * flows to NetworkView (no new collector) and renders it near the streaming
 * status as a per-link table (iface / RTT / NAK / weight) with a totals footer.
 *
 * srtla_send never runs under the mock, so the backend's own status frames carry
 * `linkTelemetry:null` and `is_streaming:false`. The WS proxy below forces
 * `is_streaming:true` (so the streaming-only panel mounts) and strips the null
 * `linkTelemetry` from every server→client frame, leaving the injected,
 * seq-less frames as the sole, deterministic source of telemetry.
 *
 * Two bonded links are fed (eth0, wlan0) with weights that sum to 100%:
 *   1. Populated — two rows render with plausible RTT/NAK/weight; totals sum.
 *   2. Stale     — wlan0 flagged stale: its row earns data-stale="true" + badge.
 *
 * Evidence PNGs (task-8-ingest-stats.png / task-8-stale-badge.png) are captured
 * out-of-band by the orchestration harness, not here: PLAYBOOK forbids
 * screenshots in functional specs, so this spec asserts via ARIA/testid only.
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
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			"Task 21 — bonded-ingest telemetry panel (Live)",
			`Generated: ${new Date().toISOString()}`,
			"",
			...lines,
			"",
		].join("\n"),
		"utf8",
	);
}

const TWO_LINKS: TelemetryEntry[] = [
	{ conn_id: "0", iface: "eth0", rtt_ms: 18, nak_count: 2, weight_percent: 60, stale: false },
	{ conn_id: "1", iface: "wlan0", rtt_ms: 47, nak_count: 5, weight_percent: 40, stale: false },
];

test.describe("Task 21 — ingest stats panel", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }) => {
		pageWs = null;

		// Force streaming on (so the streaming-only panel mounts) and drop the
		// backend's null linkTelemetry so injected frames are the only source.
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
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

	/** Inject a seq-less `status` frame carrying linkTelemetry (bypasses guard). */
	function pushTelemetry(links: TelemetryEntry[] | null): void {
		pageWs?.send(
			JSON.stringify({
				status: { is_streaming: true, linkTelemetry: links === null ? null : { links } },
			}),
		);
	}

	test("populated: two link rows render with totals summing to 100%", async ({
		page,
	}) => {
		pushTelemetry(TWO_LINKS);

		await openLiveDetails(page);
		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		const rows = panel.getByTestId("ingest-row");
		await expect(rows).toHaveCount(2);
		record("ingest-stats panel rendered with 2 link rows");

		// Each RTT cell reads "<n> ms"; NAK is a bare integer; weight a percentage.
		const rtts = panel.getByTestId("ingest-rtt");
		await expect(rtts.nth(0)).toHaveText(/^\d+\s*ms$/);
		await expect(rtts.nth(1)).toHaveText(/^\d+\s*ms$/);

		await expect(panel.getByTestId("ingest-weight").nth(0)).toHaveText("60%");
		await expect(panel.getByTestId("ingest-weight").nth(1)).toHaveText("40%");

		// Interfaces are surfaced per row. Scope to the row element — the
		// sparkline and health glyphs also carry data-iface, so a bare
		// [data-iface] selector is a strict-mode triple-match.
		await expect(
			panel.locator('[data-testid="ingest-row"][data-iface="eth0"]'),
		).toBeVisible();
		await expect(
			panel.locator('[data-testid="ingest-row"][data-iface="wlan0"]'),
		).toBeVisible();

		// Weight cells sum to ~100%; the totals footer confirms it.
		await expect(panel.getByTestId("ingest-total-weight")).toHaveText("100%");
		await expect(panel.getByTestId("ingest-total-nak")).toHaveText("7");
		record("RTT matches /\\d+ ms/, weights 60%+40%=100% total, NAK total=7 ✓");

		// No row is stale in the happy path.
		await expect(rows.nth(0)).toHaveAttribute("data-stale", "false");
		await expect(rows.nth(1)).toHaveAttribute("data-stale", "false");

		writeEvidence("task-21-ui-populated.txt", [
			"State 1 — populated",
			...evidence,
			"",
			"Result: PASS — 2 rows, plausible RTT, weights sum to 100%.",
		]);
	});

	test("stale: a stale link dims its row and shows a stale badge", async ({
		page,
	}) => {
		// wlan0 goes stale; eth0 stays fresh.
		pushTelemetry([
			TWO_LINKS[0] as TelemetryEntry,
			{ ...(TWO_LINKS[1] as TelemetryEntry), stale: true },
		]);

		await openLiveDetails(page);
		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		const staleRow = panel.locator('[data-testid="ingest-row"][data-iface="wlan0"]');
		await expect(staleRow).toHaveAttribute("data-stale", "true");

		// The row is visually dimmed (opacity < 1).
		const opacity = await staleRow.evaluate((el) => getComputedStyle(el).opacity);
		expect(Number(opacity)).toBeLessThan(1);

		// The StaleBadge marker is present for the stale interface.
		await expect(panel.locator('[data-stale-interface="wlan0"]')).toBeVisible();

		// The fresh link keeps a non-stale row.
		await expect(
			panel.locator('[data-testid="ingest-row"][data-iface="eth0"]'),
		).toHaveAttribute("data-stale", "false");
		record(`wlan0 row stale (opacity=${opacity}) + badge visible; eth0 fresh ✓`);

		writeEvidence("task-21-ui-stale.txt", [
			"State 2 — stale",
			...evidence,
			"",
			"Result: PASS — stale link dimmed + badged, fresh link unaffected.",
		]);
	});
});

test("a standalone modems frame updates the bonded name on Live, HUD and Network", async ({ page }) => {
	const roster = (network: string): ModemList => ({
		"31": {
			ifname: "wwan3", name: "RM520N - 58201", model: "RM520N",
			network_type: { supported: ["5G"], active: "5G" },
			status: { network, network_type: "5G", signal: 58, roaming: false, connection: "connected" },
		},
	});
	const netif: NetifMessage = { wwan3: { ip: "192.0.2.2", enabled: true, tp: 0 } };
	let socket: WebSocketRoute | undefined;
	let initialized = false;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
		socket = ws;
		const server = ws.connectToServer();
		server.onMessage((message) => {
			if (typeof message !== "string") { ws.send(message); return; }
			const frame = JSON.parse(message);
			if (frame.modems) delete frame.modems;
			if (frame.netif) frame.netif = netif;
			if (frame.status) {
				delete frame.status.linkTelemetry;
				delete frame.status.is_streaming;
				if (!initialized) {
					frame.status.modems = roster("Northwind");
					frame.netif = netif;
					initialized = true;
				} else {
					delete frame.status.modems;
				}
			}
			ws.send(JSON.stringify(frame));
		});
	});
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
	if (!socket) throw new Error("App socket did not connect");
	const sample = (rtt: number): LinkTelemetryMessage => ({
		links: [{ conn_id: "0", link_id: "modem-31", iface: "wwan3", rtt_ms: rtt, nak_count: 0, weight_percent: 100, stale: false }],
	});
	socket.send(JSON.stringify({ status: { is_streaming: true, linkTelemetry: sample(20) } }));
	const row = page.locator('[data-testid="ingest-row"][data-iface="wwan3"]');
	const name = row.locator("[data-link-name]");
	await expect(name).toContainText("Northwind");

	const carrier = "Harbor Cell with an exceptionally long operator name for narrow screens";
	socket.send(JSON.stringify({ modems: roster(carrier) }));
	await page.locator("[data-hud-region]").click();
	const details = page.getByRole("dialog");
	const hudName = details.getByText(carrier, { exact: false });
	await expect(hudName).toBeVisible();
	await details.getByRole("button", { name: "Close", exact: true }).click();
	await expect(details).toBeHidden();
	// No new aggregate status or telemetry frame yet: only Live used to lag.
	await expect(name).toContainText(carrier);
	await expect(name).toHaveText(`${carrier} · RM520N`);

	socket.send(JSON.stringify({ status: { linkTelemetry: sample(23) } }));
	await expect(row.getByTestId("ingest-rtt")).toHaveText("23 ms");
	socket.send(JSON.stringify({ status: { is_streaming: false } }));
	const summary = page.getByTestId("ingest-stats");
	const history = summary.locator("[data-session-link-name]");
	await expect(history).toHaveText(`Northwind · RM520N → ${carrier} · RM520N`);
	await expect(summary.getByText("2 samples", { exact: true })).toBeVisible();
	const nameCell = summary.locator("[data-session-link-name-cell]");
	const contribution = summary.getByTestId("ingest-contribution-row");
	const [nameBounds, cellBounds, rowBounds] = await Promise.all([
		history.boundingBox(), nameCell.boundingBox(), contribution.boundingBox(),
	]);
	if (!nameBounds || !cellBounds || !rowBounds) throw new Error("Summary row did not lay out");
	expect(cellBounds.width).toBeGreaterThanOrEqual(rowBounds.width - 1);
	expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(rowBounds.x + rowBounds.width + 1);
	expect(await history.evaluate((el) => {
		const text = new Range();
		text.selectNodeContents(el);
		const textBounds = text.getBoundingClientRect();
		const cellBounds = el.parentElement?.getBoundingClientRect();
		return cellBounds !== undefined && textBounds.bottom <= cellBounds.bottom + 1 &&
			textBounds.right <= cellBounds.right + 1;
	})).toBe(true);

	await navigateTo(page, "network");
	const card = page.locator('[data-testid="bonded-link-card"][data-link-id="wwan3"]');
	await expect(card.getByText(`${carrier} · RM520N`, { exact: true })).toBeVisible();
});
