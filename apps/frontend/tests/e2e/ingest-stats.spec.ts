import fs from "node:fs";
import path from "node:path";

import type { LinkTelemetryMessage, ModemList, NetifMessage, StatusResponse } from "@ceraui/rpc/schemas";
import type { WebSocketRoute } from "@playwright/test";

import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import de from "../../../../packages/i18n/messages/de.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import fr from "../../../../packages/i18n/messages/fr.json" with { type: "json" };
import hi from "../../../../packages/i18n/messages/hi.json" with { type: "json" };
import ptBR from "../../../../packages/i18n/messages/pt-BR.json" with { type: "json" };
import { expect, type Locator, test } from "./fixtures/index.js";
import { endStream, ensureAuthenticated, evidencePath, navigateTo, openLiveDetails } from "./helpers/index.js";
import { gridFitProblems, readGridFit } from "./helpers/grid-fit.js";
import { measureHitAreas } from "./helpers/hit-area.js";

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
	let streaming: boolean;
	let seq: number;

	test.beforeEach(async ({ page }) => {
		pageWs = null;
		streaming = true;
		seq = 9_000_000;

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
						frame.status.is_streaming = streaming;
						delete frame.status.stream_lifecycle;
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

	for (const [locale, labels] of [
		["en", ["Peak", "Avg", "Drops", "Duration", "Transferred"]],
		["es", ["Pico", "Prom", "Caídas", "Duración", "Transferido"]],
		["ar", ["الذروة", "المتوسط", "حالات الانقطاع", "المدة", "المنقول"]],
	] as const) {
		test(`summary labels fit at 390 px in ${locale} @mobile-only`, async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.addInitScript((code) => {
				localStorage.setItem("locale", JSON.stringify({ code }));
				localStorage.removeItem("ceraui.live.detailsOpen");
			}, locale);
			await page.reload();
			await ensureAuthenticated(page);
			await navigateTo(page, "live");
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
			const send = (status: StatusResponse) => {
				if (!pageWs) throw new Error("Missing Live control socket");
				pageWs.send(JSON.stringify({ status, seq: ++seq }));
			};
			send({ is_streaming: true, stream_lifecycle: "streaming", linkTelemetry: {
				links: TWO_LINKS,
				measured_bps: 4_200_000,
				bytes_sent_total: 7 * 1024 * 1024,
			} });
			const panel = page.getByTestId("ingest-stats");
			await expect(panel.getByTestId("ingest-row")).toHaveCount(2);
			await expect(panel).toBeHidden();
			streaming = false;
			send({ is_streaming: false, stream_lifecycle: "idle", linkTelemetry: null });
			const summary = panel.getByTestId("ingest-summary");
			await expect(summary).toBeVisible();
			for (const text of labels) {
				const label = summary.getByText(text, { exact: true });
				await expect(label).toBeVisible();
				// A CSS ellipsis leaves full text in the DOM but clips its painted width.
				expect(await label.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
			}
		});
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
	await openLiveDetails(page);
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
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Live naming check needs a configured viewport");
	await page.setViewportSize({ width: 390, height: 844 });
	const glance = page.getByRole("region", { name: "Stream", exact: true });
	await expect(glance.getByText(`${carrier} · RM520N`, { exact: true })).toBeVisible();
	await page.setViewportSize(viewport);

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

/** One summary tile as drawn: its box, and where its rendered text actually lands. */
interface SummaryTile {
	label: string;
	value: string;
	left: number;
	top: number;
	width: number;
	/** How far any rendered text reaches past the tile's padded inline edges. */
	spill: number;
	labelLines: number;
	valueLines: number;
	captionPx: number;
	/** For a value with a unit, whether its number reads first: left of the unit, or on the line above it. */
	numberBeforeUnit: boolean | null;
}

function readSummaryTiles(summary: Locator): Promise<{ gridWidth: number; tiles: SummaryTile[] }> {
	return summary.evaluate(async (root) => {
		await document.fonts.ready;
		// Let the resize restyle, then let the transitions it started finish (a
		// button's min-height animates across the 640 px touch-target rule).
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
		await Promise.all(transitions.map((transition) => transition.finished.catch(() => undefined)));
		const grid = root.firstElementChild;
		if (!(grid instanceof HTMLElement)) throw new Error("Summary grid did not render");
		const texts = (el: Element | undefined): Text[] => {
			const found: Text[] = [];
			if (!el) return found;
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node instanceof Text && node.data.trim()) found.push(node);
			}
			return found;
		};
		const rects = (node: Text, start = 0, end = node.length): DOMRect[] => {
			const range = new Range();
			range.setStart(node, start);
			range.setEnd(node, end);
			return [...range.getClientRects()].filter((rect) => rect.width > 0);
		};
		const lines = (nodes: Text[]): number =>
			new Set(nodes.flatMap((node) => rects(node)).map((rect) => Math.round(rect.top))).size;
		const wordRect = (node: Text, word: string, fromEnd: boolean): DOMRect | undefined => {
			const at = fromEnd ? node.data.lastIndexOf(word) : node.data.indexOf(word);
			return rects(node, at, at + word.length)[0];
		};
		return {
			gridWidth: grid.clientWidth,
			tiles: [...grid.children].map((tile) => {
				const box = tile.getBoundingClientRect();
				const style = getComputedStyle(tile);
				const start = box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
				const end = box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight);
				const [labelRow, valueBox] = tile.children;
				const label = texts(labelRow);
				const value = texts(valueBox);
				const drawn = [...label, ...value].flatMap((node) => rects(node));
				const words = value[0]?.data.trim().split(/\s+/) ?? [];
				const number = value[0] && words.length > 1 ? wordRect(value[0], words[0] ?? "", false) : undefined;
				const unit = value[0] && words.length > 1 ? wordRect(value[0], words.at(-1) ?? "", true) : undefined;
				return {
					label: label.map((node) => node.data.trim()).join(" "),
					value: value.map((node) => node.data.trim()).join(" "),
					left: box.left,
					top: box.top,
					width: box.width,
					spill: Math.max(0, ...drawn.map((rect) => Math.max(start - rect.left, rect.right - end))),
					labelLines: lines(label),
					valueLines: lines(value),
					captionPx: labelRow ? Number.parseFloat(getComputedStyle(labelRow).fontSize) : 0,
					numberBeforeUnit:
						number && unit
							? Math.abs(number.top - unit.top) < 1
								? number.right <= unit.left + 0.5
								: number.top < unit.top
							: null,
				};
			}),
		};
	});
}

type SummaryShape = "five" | "two";

/**
 * Every way the drawn summary breaks the fit rule, as readable lines. In a card
 * too narrow for a word, the text may break anywhere but must stay in its tile.
 */
function summaryProblems(
	where: string,
	rtl: boolean,
	expected: SummaryShape | "either",
	{ gridWidth, tiles }: { gridWidth: number; tiles: SummaryTile[] },
	wordsMayBreak = false,
): string[] {
	const [peak, avg, drops, duration, transferred] = tiles;
	if (!peak || !avg || !drops || !duration || !transferred || tiles.length !== 5) {
		return [`${where}: expected five tiles, found ${tiles.length}`];
	}
	const near = (a: number, b: number) => Math.abs(a - b) <= 1;
	const five = tiles.every((tile) => near(tile.top, peak.top));
	const two =
		near(peak.top, avg.top) &&
		near(drops.top, duration.top) &&
		drops.top > peak.top &&
		transferred.top > drops.top &&
		near(transferred.width, gridWidth);
	const shape = five ? "five" : two ? "two" : "neither five in a row nor two with a full-row Transferred";
	const problems: string[] = [];
	if (expected === "either" ? !five && !two : shape !== expected) {
		problems.push(`${where}: tiles are ${shape}, expected ${expected}`);
	}
	if (peak.left > avg.left !== rtl) problems.push(`${where}: tiles do not follow the reading direction`);
	for (const tile of tiles) {
		const name = `"${tile.label}" / "${tile.value}"`;
		if (!tile.label || !tile.value) problems.push(`${where}: ${name} lost its text`);
		if (tile.captionPx < 12) problems.push(`${where}: ${name} caption is ${tile.captionPx} px, below 12 px`);
		if (tile.spill > 0.5) problems.push(`${where}: ${name} reaches ${tile.spill.toFixed(1)} px past its tile's padding`);
		if (!wordsMayBreak && tile.labelLines > tile.label.split(/\s+/).length) {
			problems.push(`${where}: ${name} label breaks inside a word (${tile.labelLines} lines)`);
		}
		if (!wordsMayBreak && tile.valueLines > 1) problems.push(`${where}: ${name} value wraps (${tile.valueLines} lines)`);
		if (tile.numberBeforeUnit === false) problems.push(`${where}: ${name} draws its unit before its number`);
	}
	return problems;
}

/** Boxes that must share one column: the same inline start and width as the first. */
function columnProblems(where: string, boxes: ReadonlyArray<{ x: number; width: number } | null>): string[] {
	const [first] = boxes;
	if (!first) return [`${where}: the column's first box did not render`];
	return boxes.flatMap((box, line) =>
		box && Math.abs(box.x - first.x) <= 1 && Math.abs(box.width - first.width) <= 1
			? []
			: [`${where}: line ${line} is out of the header's column (${box ? `x ${box.x.toFixed(1)}, width ${box.width.toFixed(1)}` : "missing"})`],
	);
}

const SUMMARY_LOCALES = { ar, de, en, fr, hi, "pt-BR": ptBR } as const;
const SUMMARY_WIDTHS = [320, 390, 412, 540, 600, 641, 800, 1280] as const;
// The live table also at 1024 px, the kiosk, whose live card is a phone's 308 px.
const LIVE_WIDTHS = [320, 390, 412, 540, 600, 641, 800, 1024, 1280] as const;
const SUMMARY_LINK = { conn_id: "0", link_id: "wired", iface: "eth0", rtt_ms: 18, nak_count: 0, weight_percent: 100, stale: false };
// A modem whose carrier name runs past two lines in a phone's card.
const SUMMARY_ROSTER: ModemList = {
	"31": {
		ifname: "wwan3", name: "RM520N - 58201", model: "RM520N",
		network_type: { supported: ["5G"], active: "5G" },
		status: { network: "Harbor Cell with an exceptionally long operator name for narrow screens", network_type: "5G", signal: 58, roaming: false, connection: "connected" },
	},
};
const SUMMARY_READINGS: ReadonlyArray<readonly [string, LinkTelemetryMessage]> = [
	// The widest bitrate the tiles format, a session past 10 GB, a slow, lossy link,
	// a USB Ethernet adapter with a full 15-character interface name, and the modem.
	["large", {
		links: [
			{ ...SUMMARY_LINK, rtt_ms: 1234, nak_count: 99_999, weight_percent: 60, bitrate_bps: 999_900_000 },
			{ ...SUMMARY_LINK, conn_id: "1", link_id: "usb-ethernet", iface: "enx0c5b8f279a64", weight_percent: 30 },
			{ ...SUMMARY_LINK, conn_id: "2", link_id: "modem-31", iface: "wwan3", weight_percent: 10 },
		],
		measured_bps: 999_900_000,
		bytes_sent_total: 12.5 * 1024 ** 3,
	}],
	// Nothing measured: peak, average and transferred are dashes.
	["unknown", { links: [SUMMARY_LINK] }],
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// The session summary after a real Start, Live, Stop and End stream on the
// worker's mock backend, swept across phone, tablet and desktop widths. Each
// test sets its own device and viewports, so the desktop project alone runs it.
test.describe("session summary tiles keep their text inside each tile @desktop-only", () => {
	// A phone draws overlay scrollbars; a desktop scrollbar gutter would take 15 px
	// of the card and move every width this sweeps.
	test.use({ isMobile: true, hasTouch: true });

	test.beforeEach(async ({ backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], { source: "usb", srtla_addr: "127.0.0.1", srtla_port: 5000 });
	});

	for (const [locale, messages] of Object.entries(SUMMARY_LOCALES)) {
		test(`${locale}: large and unknown readings fit at every width`, async ({ page }) => {
			// Two real sessions and a nine-step sweep each.
			test.slow();
			let socket: WebSocketRoute | undefined;
			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				socket = ws;
				const server = ws.connectToServer();
				ws.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					// The mock never runs the sender, so its frames carry no telemetry; drop
					// the key so the injected reading stands. Stream state stays the backend's.
					// The roster is the test's, so the modem link carries the long carrier name.
					const frame: unknown = typeof message === "string" ? JSON.parse(message) : undefined;
					if (!isRecord(frame)) {
						ws.send(message);
						return;
					}
					if (isRecord(frame.status)) {
						delete frame.status.linkTelemetry;
						delete frame.status.link_telemetry_waiting;
						if ("modems" in frame.status) frame.status.modems = SUMMARY_ROSTER;
					}
					if ("modems" in frame) frame.modems = SUMMARY_ROSTER;
					if (isRecord(frame.netif)) frame.netif = { ...frame.netif, wwan3: { ip: "192.0.2.3", enabled: true, tp: 0 } };
					ws.send(JSON.stringify(frame));
				});
			});
			await page.addInitScript((code) => {
				localStorage.setItem("locale", JSON.stringify({ code }));
				// Hold the summary window open for the whole sweep.
				Object.assign(window, { __ceraSummaryWindowMs: 600_000 });
			}, locale);
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
			// A touch browser is offered the install banner over the Live bar first.
			const installPrompt = page.getByRole("button", { name: messages["pwa.installIosGotIt"], exact: true });
			await installPrompt.click();
			await expect(installPrompt).toHaveCount(0);
			if (!socket) throw new Error("Live control socket was not routed");
			socket.send(JSON.stringify({ modems: SUMMARY_ROSTER }));
			const rtl = locale === "ar";
			const problems: string[] = [];

			for (const [reading, telemetry] of SUMMARY_READINGS) {
				await page.setViewportSize({ width: 1280, height: 800 });
				await page.getByTestId("live-bar").getByRole("button", { name: messages["live.startStream"], exact: true }).click();
				const cockpit = page.getByTestId("live-cockpit");
				await expect(cockpit).toHaveAttribute("data-summary-mode", "false", { timeout: 15_000 });
				if (!socket) throw new Error("Live control socket was not routed");
				socket.send(JSON.stringify({ status: { linkTelemetry: telemetry } }));
				await expect(page.getByTestId("ingest-row")).toHaveCount(telemetry.links.length);
				if (reading === "large") {
					await expect(page.locator('[data-testid="ingest-row"][data-iface="enx0c5b8f279a64"]')).toContainText("enx0c5b8f279a64");
					await expect(page.locator('[data-testid="ingest-row"][data-iface="wwan3"] [data-link-name]')).toContainText("Harbor Cell with an exceptionally long operator name");
				}

				// Live: every line of the per-link table keeps each name whole and inside
				// the card at 12 px or more, and its three readings stay in the header's
				// columns, whether they sit beside the name or below it.
				const panel = page.getByTestId("ingest-stats");
				const telemetryCard = page.getByTestId("telemetry-card");
				const liveProblems = async (where: string, beside = false): Promise<string[]> => {
					const rows = await panel.getByTestId("ingest-row").all();
					const lines = [
						panel.getByTestId("ingest-live-header"),
						...rows.map((row) => row.locator(":scope > div").first()),
						panel.getByTestId("ingest-totals"),
					];
					const found: string[] = [];
					for (const line of lines) found.push(...gridFitProblems(where, await readGridFit(line, panel), { minFontPx: 12 }));
					for (const row of rows) {
						found.push(...gridFitProblems(where, await readGridFit(row.locator(":scope > div").nth(1), panel), { minFontPx: 12 }));
					}
					found.push(...columnProblems(where, await Promise.all(lines.map((line) => line.locator(":scope > :last-child").boundingBox()))));
					if (beside) {
						// A desktop card keeps each line's readings beside its name; a long
						// carrier name wraps instead of pushing them below.
						for (const [index, line] of lines.entries()) {
							const [name, readings] = await Promise.all(
								[":scope > :first-child", ":scope > :last-child"].map((child) => line.locator(child).boundingBox()),
							);
							if (!name || !readings || readings.y >= name.y + name.height - 1) found.push(`${where}: line ${index} drops its readings below its name`);
						}
					}
					return found;
				};
				const live: string[] = [];
				for (const width of LIVE_WIDTHS) {
					await page.setViewportSize({ width, height: 800 });
					// Below 1024 px the table is folded behind Details.
					if (width < 1024) await openLiveDetails(page);
					live.push(...(await liveProblems(`${locale} ${reading} live at ${width} px`, width >= 1280)));
				}
				await telemetryCard.evaluate((el) => {
					el.style.maxWidth = "22.5rem";
				});
				live.push(...(await liveProblems(`${locale} ${reading} live in a 22.5rem card at 1280 px`)));
				await telemetryCard.evaluate((el) => {
					el.style.maxWidth = "";
				});
				// Reported before Stop: a live line that overflows its card can cover the
				// live bar, and the test would then end on Stop's timeout, not on the line.
				expect.soft(live, `${locale} ${reading} live table`).toEqual([]);

				await endStream(page);
				const summary = page.getByTestId("ingest-summary");
				await expect(summary).toBeVisible({ timeout: 15_000 });
				// The per-link header and its rows: whole, inside the card, and NAK and RTT
				// in the header's columns.
				const contributionProblems = async (where: string, wordsMayBreak = false): Promise<string[]> => {
					const header = summary.getByTestId("ingest-contribution-header");
					const rows = await summary.getByTestId("ingest-contribution-row").all();
					const found: string[] = [];
					for (const line of [header, ...rows]) {
						found.push(...gridFitProblems(where, await readGridFit(line, panel), { minFontPx: 12, wordsMayBreak }));
					}
					for (const [column, cell] of [[0, "[data-session-link-name-cell]"], [2, "[data-testid=ingest-link-nak]"], [3, "[data-testid=ingest-link-rtt]"]] as const) {
						const boxes = [header.locator(":scope > *").nth(column), ...rows.map((row) => row.locator(cell))];
						found.push(...columnProblems(`${where} ${cell}`, await Promise.all(boxes.map((box) => box.boundingBox()))));
					}
					return found;
				};
				if (reading === "large") {
					await expect(summary.getByTestId("ingest-summary-peak")).toHaveText("999.9 Mbps");
					await expect(summary.getByTestId("ingest-summary-transferred")).toContainText("GB");
				} else {
					for (const id of ["ingest-summary-peak", "ingest-summary-avg", "ingest-summary-transferred"]) {
						await expect(summary.getByTestId(id)).toHaveText("—");
					}
				}

				for (const width of SUMMARY_WIDTHS) {
					await page.setViewportSize({ width, height: 800 });
					const where = `${locale} ${reading} at ${width} px`;
					const expected = width <= 641 ? "two" : width >= 1280 ? "five" : "either";
					problems.push(...summaryProblems(where, rtl, expected, await readSummaryTiles(summary)));
					problems.push(...(await contributionProblems(where)));
					if (width >= 1280) {
						// A desktop card has room for the name beside Share, NAK and RTT.
						const [name, share] = await Promise.all(
							[0, 1].map((n) => summary.getByTestId("ingest-contribution-header").locator(":scope > *").nth(n).boundingBox()),
						);
						if (!name || !share || Math.abs(name.y - share.y) > 1) problems.push(`${where}: the contribution header is not one line`);
					}
					const [done] = await measureHitAreas(page, '[data-testid="summary-done"]');
					if (!done || done.hitHeight < 44) problems.push(`${where}: Done answers to ${done?.hitHeight ?? 0} px, below 44 px`);
				}

				// The app always draws the summary full width, so narrow its card in a
				// desktop window: the tiles must follow the card, not the window. The
				// 240 px card is narrower than a caption word, standing in for a longer
				// translation or fallback font: text may break but never leaves its tile.
				for (const [maxWidth, wordsMayBreak] of [["22.5rem", false], ["15rem", true]] as const) {
					await telemetryCard.evaluate((el, value) => {
						el.style.maxWidth = value;
					}, maxWidth);
					const where = `${locale} ${reading} in a ${maxWidth} card at 1280 px`;
					problems.push(...summaryProblems(where, rtl, "two", await readSummaryTiles(summary), wordsMayBreak));
					problems.push(...(await contributionProblems(where, wordsMayBreak)));
				}
				await telemetryCard.evaluate((el) => {
					el.style.maxWidth = "";
				});

				await page.getByTestId("summary-done").click();
				await expect(page.getByTestId("idle-cockpit")).toBeVisible();
			}
			expect(problems).toEqual([]);
		});
	}
});
