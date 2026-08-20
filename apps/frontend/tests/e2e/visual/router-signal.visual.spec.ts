import fs from "node:fs";
import path from "node:path";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual + programmatic gate for the router-dongle signal glyph (Phase-C todo
 * 21). Todo 20 normalized what a router-mode dongle's OWN web admin API reports;
 * this proves it reaches an operator honestly, in a real browser.
 *
 * EVERY criterion is a PASS/FAIL assertion the suite makes itself. The PNGs are
 * evidence for a human reader, never the check — nothing here passes or fails on
 * how a capture looks. The three properties that would otherwise be eyeball work
 * are mechanical instead:
 *
 *   1. a reading and a NON-reading are distinguishable with colour removed —
 *      a reading is glyph-only, every degraded state prints its own WORD and no
 *      digit at all, so a monochrome kiosk still reads them apart;
 *   2. a STALE reading is provably not painted as a live one — the rendered
 *      `color` of the same tier is compared live-vs-stale rather than a class
 *      name, which a CSS regression would walk straight through;
 *   3. the two instruments never share a row — a dongle draws
 *      `modem-router-signal` and an MM radio draws `modem-signal`, never both.
 *
 * FIXTURE PROVENANCE, per todo 20's evidence: every HiLink/ZTE unit on the bench
 * is SIM-LESS, so no capture exists in which one reported a populated radio
 * metric. The SIM-less fixture below IS the bench truth; the populated ones are
 * SHAPE-DERIVED (real field names, real per-dialect support, supplied numbers)
 * and are never presented as readings taken from hardware.
 *
 * Determinism: the page socket is proxied and the backend's own `status` /
 * `config` / `netif` / `modems` echoes are DROPPED, so the injected roster is
 * the only truth on screen — the same drop shape `modem-ux.visual.spec.ts` uses.
 */

// visual -> e2e -> tests -> frontend -> apps -> CeraUI (repo root). Repo-local and
// gitignored; tests never write above the checkout (root AGENTS.md Rule D).
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/modem-phase-c/21",
);

let pageWs: WebSocketRoute | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

function serverConfig(): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
		},
	});
}

function sendModems(modems: Record<string, unknown>): void {
	send({ status: { modems } });
}

function sendNetif(netif: Record<string, unknown>): void {
	send({ netif });
}

// ── Signal fixtures ──────────────────────────────────────────────────────────

type Metric =
	| { state: "known"; value: number }
	| { state: "unknown"; reason: string };

const known = (value: number): Metric => ({ state: "known", value });
const unknown = (reason: string): Metric => ({ state: "unknown", reason });
const UNSUPPORTED = unknown("unsupported");

type Signal = Record<string, unknown>;

/** HiLink publishes bars + scale + rssi/rsrp/rsrq/sinr, and NO `snr` key. */
function hilinkSignal(over: Signal = {}): Signal {
	return {
		provenance: "hilink-admin-api",
		freshness: "live",
		bars: known(4),
		max_bars: known(5),
		dbm: known(-71),
		rsrp: known(-95),
		rsrq: known(-11),
		snr: UNSUPPORTED,
		sinr: known(9),
		...over,
	};
}

/** ZTE publishes `signalbar` on a fixed 5-scale + `lte_snr`, and NO `sinr`. */
function zteSignal(over: Signal = {}): Signal {
	return {
		provenance: "zte-goform",
		freshness: "live",
		bars: known(3),
		max_bars: known(5),
		dbm: known(-79),
		rsrp: known(-98),
		rsrq: known(-12),
		snr: known(7),
		sinr: UNSUPPORTED,
		...over,
	};
}

/** UFI's `himiapi` publishes ONE scalar in dBm and no bar scale whatsoever. */
function ufiSignal(over: Signal = {}): Signal {
	return {
		provenance: "ufi-himiapi",
		freshness: "live",
		bars: UNSUPPORTED,
		max_bars: UNSUPPORTED,
		dbm: known(-96),
		rsrp: UNSUPPORTED,
		rsrq: UNSUPPORTED,
		snr: UNSUPPORTED,
		sinr: UNSUPPORTED,
		...over,
	};
}

function degraded(base: Signal, reason: string): Signal {
	const next: Signal = { ...base, freshness: "unknown" };
	for (const id of [
		"bars",
		"max_bars",
		"dbm",
		"rsrp",
		"rsrq",
		"snr",
		"sinr",
	]) {
		const metric = base[id] as Metric;
		if (metric.state === "unknown" && metric.reason === "unsupported") continue;
		next[id] = unknown(reason);
	}
	return next;
}

function dongleRow(
	ifname: string,
	name: string,
	signal: Signal | undefined,
	adminOver: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ifname,
		name,
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			...(signal !== undefined ? { signal } : {}),
			...adminOver,
		},
	};
}

/** An MM radio, so the two instruments are photographed side by side. */
const MM_RADIO: Record<string, unknown> = {
	ifname: "wwan0",
	name: "Quectel RM520N",
	network_type: { supported: ["5g", "lte"], active: "lte" },
	config: { apn: "", username: "", password: "", roaming: false, network: "" },
	status: {
		connection: "connected",
		network_type: "lte",
		signal: 71,
		roaming: false,
		network: "Test Carrier",
	},
	no_sim: false,
	device_class: "usb",
};

const READING_ROSTER: Record<string, unknown> = {
	"radio-mm": MM_RADIO,
	"dongle-hilink": dongleRow("enx0c5b8f279a64", "Huawei E3372", hilinkSignal()),
	"dongle-zte": dongleRow("enx344b50000000", "ZTE MF79U", zteSignal()),
	"dongle-ufi": dongleRow("enx020754023235", "Qualcomm 9024", ufiSignal()),
};

const DEGRADED_ROSTER: Record<string, unknown> = {
	// The real bench truth: `SimStatus 255` with every signal element empty.
	"dongle-nosim": dongleRow(
		"enx0c5b8f279a64",
		"Huawei E3372",
		hilinkSignal({
			bars: known(0),
			max_bars: known(5),
			dbm: unknown("not-reported"),
			rsrp: unknown("not-reported"),
			rsrq: unknown("not-reported"),
			sinr: unknown("not-reported"),
		}),
		{ sim: "absent" },
	),
	"dongle-unreachable": dongleRow(
		"enx344b50000000",
		"ZTE MF79U",
		degraded(zteSignal(), "unreachable"),
		{ reachable: false },
	),
	"dongle-auth": dongleRow(
		"enx020754023235",
		"Qualcomm 9024",
		degraded(ufiSignal(), "auth-expired"),
	),
	"dongle-malformed": dongleRow(
		"enx020a53313630",
		"Qualcomm 9091",
		degraded(hilinkSignal(), "malformed"),
	),
	"dongle-blank": dongleRow(
		"eth1",
		"Huawei E3372 (twin)",
		degraded(zteSignal(), "not-reported"),
	),
	"dongle-acquiring": {
		ifname: "enx7a1122334455",
		name: "ZTE MF79U (leasing)",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "dongle_acquiring",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			signal: degraded(zteSignal(), "not-reported"),
		},
	},
};

/**
 * A roster built to break signal-glyph alignment, not to look pretty.
 *
 * Both row SHAPES appear (MM radio and router-ethernet dongle) AND both bond
 * states appear on each shape, because the two defects this pins are orthogonal
 * and each needs its own axis:
 *
 *   · the bond word — `In Bond` and `Excluded` differ in width, and the toggle
 *     that prints them sits to the RIGHT of the glyph inside a `shrink-0`
 *     cluster, so its width displaces the glyph. Measured on the bench board,
 *     7px, splitting seven rows into two columns;
 *   · the chip box — the dongle chip insets its bars by its own frame plus
 *     `px-1.5` while the MM glyph's bars WERE its right edge, a further 6px.
 *
 * A roster whose rows are all bonded, or all one shape, passes on the broken
 * tree.
 */
const ALIGNMENT_ROSTER: Record<string, unknown> = {
	"align-mm-bonded": {
		...MM_RADIO,
		ifname: "wwan0",
		name: "Quectel RM520N (bonded)",
	},
	"align-mm-excluded": {
		...MM_RADIO,
		ifname: "wwan1",
		name: "Quectel RM520N (excluded)",
	},
	"align-zte-bonded": dongleRow(
		"enx344b50000000",
		"ZTE MF79U (bonded)",
		zteSignal(),
	),
	"align-hilink-excluded": dongleRow(
		"enx0c5b8f279a64",
		"Huawei E3372 (excluded)",
		hilinkSignal(),
	),
	"align-ufi-bonded": dongleRow(
		"enx020754023235",
		"Qualcomm 9024 (bonded)",
		ufiSignal(),
	),
};

/** Bonded rows get an address and `enabled`; excluded rows get neither. */
const ALIGNMENT_NETIF: Record<string, unknown> = {
	eth0: { ip: "192.168.1.50", tp: 0, enabled: true },
	wwan0: { ip: "10.0.0.5", tp: 4, enabled: true },
	wwan1: { tp: 0, enabled: false },
	enx344b50000000: { ip: "192.168.0.169", tp: 12, enabled: true },
	enx0c5b8f279a64: { tp: 0, enabled: false },
	enx020754023235: { ip: "192.168.100.2", tp: 0, enabled: true },
};

const STALE_ROSTER: Record<string, unknown> = {
	"dongle-live": dongleRow("enx344b50000000", "ZTE MF79U (live)", zteSignal()),
	"dongle-stale": dongleRow(
		"enx0c5b8f279a64",
		"ZTE MF79U (carried)",
		zteSignal({ freshness: "stale" }),
	),
};

const NETIF: Record<string, unknown> = {
	eth0: { ip: "192.168.1.50", tp: 0, enabled: true },
	wwan0: { ip: "10.0.0.5", tp: 4, enabled: true },
	enx0c5b8f279a64: { ip: "192.168.8.100", tp: 0, enabled: true },
	enx344b50000000: { ip: "192.168.0.169", tp: 12, enabled: true },
	enx020754023235: { ip: "192.168.100.2", tp: 0, enabled: true },
	enx020a53313630: { ip: "192.168.100.3", tp: 0, enabled: true },
	eth1: { tp: 0, enabled: false },
	enx7a1122334455: { tp: 0, enabled: false },
};

// ── Locators ─────────────────────────────────────────────────────────────────

const cellularSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("modem-row") }).first();

const modemRow = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="modem-row"][data-modem-id="${id}"]`);

const routerSignal = (page: Page, id: string): Locator =>
	modemRow(page, id).getByTestId("modem-router-signal");

type Condition = {
	readonly name: string;
	readonly project: "desktop" | "mobile";
	readonly viewport: { width: number; height: number };
	readonly touch?: boolean;
};

const CONDITIONS: readonly Condition[] = [
	{ name: "desktop", project: "desktop", viewport: { width: 1280, height: 800 } },
	{
		name: "kiosk-1024x600",
		project: "desktop",
		viewport: { width: 1024, height: 600 },
		touch: true,
	},
	{ name: "mobile", project: "mobile", viewport: { width: 390, height: 844 } },
];

for (const condition of CONDITIONS) {
	test.describe(`@visual router-dongle signal — ${condition.name}`, () => {
		const shot = (surface: string): string =>
			path.join(EVIDENCE_DIR, `${surface}-${condition.name}.png`);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);

			pageWs = null;
			fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

			await page.setViewportSize(condition.viewport);

			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				pageWs = ws;
				const server = ws.connectToServer();
				ws.onMessage((m) => server.send(m));
				server.onMessage((m) => {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as object;
						// The injected roster / interfaces / config are authoritative.
						if ("status" in frame) return;
						if ("config" in frame) return;
						if ("netif" in frame) return;
						if ("modems" in frame) return;
					} catch {
						/* non-JSON / binary frame */
					}
					ws.send(m);
				});
			});

			await page.goto(condition.touch === true ? "/?mode=touch" : "/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");

			if (condition.touch === true) {
				await expect(page.locator("html")).toHaveAttribute(
					"data-layout-mode",
					"touch",
				);
			}
		});

		test("every dialect draws its own glyph, and never ModemManager's", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendNetif(NETIF);
			sendModems(READING_ROSTER);

			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("modem-row")).toHaveCount(4);

			for (const [id, provenance, tier] of [
				["dongle-hilink", "hilink-admin-api", "high"],
				["dongle-zte", "zte-goform", "medium"],
				["dongle-ufi", "ufi-himiapi", "low"],
			] as const) {
				const chip = routerSignal(page, id);
				await expect(chip).toBeVisible();
				await expect(chip).toHaveAttribute("data-provenance", provenance);
				await expect(chip).toHaveAttribute("data-signal-state", "reading");
				await expect(chip).toHaveAttribute("data-signal-tier", tier);
				await expect(chip).toHaveAttribute("data-live", "true");
				// The two instruments never share a row.
				await expect(modemRow(page, id).getByTestId("modem-signal")).toHaveCount(0);
			}

			// The MM radio keeps its own glyph and gains no router one.
			await expect(modemRow(page, "radio-mm").getByTestId("modem-signal")).toBeVisible();
			await expect(routerSignal(page, "radio-mm")).toHaveCount(0);

			const sectionText = await section.innerText();
			expect(sectionText).not.toMatch(/network\.[a-z]+\.[a-zA-Z.]+/);
			for (const token of [
				"hilink-admin-api",
				"zte-goform",
				"ufi-himiapi",
				"not-reported",
				"auth-expired",
			]) {
				expect(sectionText).not.toContain(token);
			}

			await section.screenshot({ path: shot("router-signal-readings") });
		});

		test("every row's signal bars land in ONE column, whatever the row says", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendNetif(ALIGNMENT_NETIF);
			sendModems(ALIGNMENT_ROSTER);

			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("modem-row")).toHaveCount(5);
			await expect(page.getByTestId("modem-signal")).toHaveCount(2);
			await expect(page.getByTestId("modem-router-signal")).toHaveCount(3);

			// RENDERED GEOMETRY, not a class name. The tier glyph is the LAST svg in
			// either indicator — the dongle chip leads with its `Router` provenance
			// mark — so this measures the bars an operator actually scans down.
			const offsets = await page.evaluate(() =>
				Array.from(
					document.querySelectorAll<HTMLElement>('[data-testid="modem-row"]'),
				).map((row) => {
					const indicator = row.querySelector<HTMLElement>(
						'[data-testid="modem-signal"], [data-testid="modem-router-signal"]',
					);
					const svgs = indicator?.querySelectorAll("svg") ?? [];
					const bars = svgs[svgs.length - 1];
					return {
						id: row.dataset.modemId ?? "?",
						offRight:
							bars === undefined
								? null
								: row.getBoundingClientRect().right -
									bars.getBoundingClientRect().right,
					};
				}),
			);

			const measured = offsets.filter((o) => o.offRight !== null);
			expect(measured).toHaveLength(5);

			// Subpixel layout means exact equality is the wrong assertion; a 1px
			// tolerance still fails the 6px and 7px regressions this pins.
			const values = measured.map((o) => o.offRight as number);
			const spread = Math.max(...values) - Math.min(...values);
			expect(
				spread,
				`signal bars are not in one column: ${JSON.stringify(measured)}`,
			).toBeLessThanOrEqual(1);

			// And the reserve is REAL: the bond word's slot is as wide as the wider
			// of the two states, so the two shapes measure the same box.
			const bondWidths = await page.evaluate(() =>
				Array.from(
					document.querySelectorAll<HTMLElement>('[data-testid^="bond-state-"]'),
				).map((el) => Math.round(el.getBoundingClientRect().width)),
			);
			expect(bondWidths.length).toBeGreaterThan(1);
			expect(new Set(bondWidths).size).toBe(1);

			await section.screenshot({ path: shot("signal-column-alignment") });
		});

		test("a degraded reading is an honest band — a word, no bars, no spinner", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendNetif(NETIF);
			sendModems(DEGRADED_ROSTER);

			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });

			const cases = [
				["dongle-nosim", "no-sim", null],
				["dongle-unreachable", "unknown", "unreachable"],
				["dongle-auth", "unknown", "auth-expired"],
				["dongle-malformed", "unknown", "malformed"],
				["dongle-blank", "unknown", "not-reported"],
			] as const;

			const words = new Set<string>();
			for (const [id, state, reason] of cases) {
				const chip = routerSignal(page, id);
				await expect(chip).toBeVisible();
				await expect(chip).toHaveAttribute("data-signal-state", state);
				// No fabricated magnitude, in any degraded state.
				await expect(chip).not.toHaveAttribute("data-signal-tier", /.*/);
				if (reason !== null) {
					await expect(chip).toHaveAttribute("data-unknown-reason", reason);
				}

				// The state is carried by a WORD, not by a mark or a colour — the
				// shipped kiosk touchscreen cannot hover to reveal a title.
				const text = (await chip.innerText()).trim();
				expect(text.length, `${id} rendered no word`).toBeGreaterThan(0);
				expect(text, `${id} rendered a digit`).not.toMatch(/\d/);
				words.add(text);
			}
			// Five distinct operator facts must read as five distinct sentences.
			expect(words.size).toBe(cases.length);

			// An acquiring dongle states its lifecycle without an endless spinner.
			await expect(modemRow(page, "dongle-acquiring")).toHaveAttribute(
				"data-modem-state",
				"router-acquiring",
			);
			await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
			await expect(section.locator(".animate-spin")).toHaveCount(0);

			expect(await section.innerText()).not.toMatch(/network\.[a-z]+\.[a-zA-Z.]+/);
			await section.screenshot({ path: shot("router-signal-degraded") });
		});

		test("a carried-over reading keeps its value and loses its live claim", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendNetif(NETIF);
			sendModems(STALE_ROSTER);

			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });

			const live = routerSignal(page, "dongle-live");
			const stale = routerSignal(page, "dongle-stale");

			// Same dialect, same tier — so any difference below is the freshness.
			await expect(live).toHaveAttribute("data-signal-tier", "medium");
			await expect(stale).toHaveAttribute("data-signal-tier", "medium");
			await expect(live).toHaveAttribute("data-live", "true");
			await expect(stale).toHaveAttribute("data-live", "false");
			await expect(stale).toHaveAttribute("data-freshness", "stale");

			// It says so out loud, and it is not painted as a live reading. The
			// colour is read off the RENDERED style rather than a class name, which
			// a CSS regression would walk straight through.
			await expect(
				modemRow(page, "dongle-stale").getByTestId("modem-router-signal-stale"),
			).toBeVisible();
			await expect(
				modemRow(page, "dongle-live").getByTestId("modem-router-signal-stale"),
			).toHaveCount(0);

			const colourOf = (chip: Locator) =>
				chip.evaluate((el) => getComputedStyle(el).color);
			expect(await colourOf(stale)).not.toBe(await colourOf(live));

			await section.screenshot({ path: shot("router-signal-stale") });
		});

		test("the detail strip prints each metric's own unit and omits what the dialect cannot express", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendNetif(NETIF);
			sendModems(READING_ROSTER);

			await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });

			for (const id of ["dongle-hilink", "dongle-zte", "dongle-ufi"] as const) {
				await modemRow(page, id).getByTestId("modem-details-toggle").click();
			}

			const hilink = modemRow(page, "dongle-hilink");
			await expect(hilink.getByTestId("router-signal-bars")).toHaveText("4 / 5");
			await expect(hilink.getByTestId("router-signal-dbm")).toHaveText("-71 dBm");
			await expect(hilink.getByTestId("router-signal-rsrp")).toHaveText("-95 dBm");
			// The three ratios are dB, the two powers are dBm — folding them onto one
			// unit is the same class of error as folding `snr` into `sinr`.
			await expect(hilink.getByTestId("router-signal-rsrq")).toHaveText("-11 dB");
			await expect(hilink.getByTestId("router-signal-sinr")).toHaveText("9 dB");
			// HiLink's API has no `snr` key at all, so the metric is ABSENT — never a
			// dash, which would read as "the radio reported nothing".
			await expect(hilink.getByTestId("router-signal-snr")).toHaveCount(0);

			// ZTE is the mirror image: it publishes `lte_snr` and no `sinr`.
			const zte = modemRow(page, "dongle-zte");
			await expect(zte.getByTestId("router-signal-snr")).toHaveText("7 dB");
			await expect(zte.getByTestId("router-signal-sinr")).toHaveCount(0);

			// UFI publishes ONE scalar and no bar scale whatsoever.
			const ufi = modemRow(page, "dongle-ufi");
			await expect(ufi.getByTestId("router-signal-dbm")).toHaveText("-96 dBm");
			for (const absent of ["bars", "rsrp", "rsrq", "snr", "sinr"]) {
				await expect(ufi.getByTestId(`router-signal-${absent}`)).toHaveCount(0);
			}

			// The strip states which instrument produced it, on screen.
			await expect(hilink.getByTestId("router-signal-detail")).toContainText(
				"web interface",
			);

			const section = cellularSection(page);
			expect(await section.innerText()).not.toMatch(/network\.[a-z]+\.[a-zA-Z.]+/);
			await section.screenshot({ path: shot("router-signal-detail-strip") });
		});
	});
}
