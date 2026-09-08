import fs from "node:fs";
import path from "node:path";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual + programmatic gate for the BONDED-LINKS signal glyph.
 *
 * An operator reported two different glyph treatments in one Bonded Links list:
 * a NetworkManager-managed modem drew the spectral bar cluster, while a
 * self-managed router dongle (ZTE MF79U and friends) drew a bare, muted
 * fallback in the same slot — for the same question, "how is this link's radio".
 *
 * The cause was never the glyph: `buildBond` read a modem's percentage from
 * `status.signal` alone, and a `router-ethernet` row has no `status` block and
 * never will. Its reading lives on `router_admin.signal`, already normalized and
 * already rendered on the Cellular card. This spec proves the bonded row now
 * resolves BOTH instruments into the SAME bar cluster.
 *
 * Every criterion is a PASS/FAIL assertion this suite makes itself; the PNGs are
 * evidence for a human reader, never the check. Three properties are mechanical
 * rather than eyeball work:
 *
 *   1. every bonded modem row — managed or self-managed — renders the SAME
 *      glyph component, asserted by the `data-link-level` bar cluster the
 *      indicator only emits in its bar branch;
 *   2. a self-managed dongle's bar count follows its OWN published tier, so a
 *      strong dongle and a weak one are distinguishable;
 *   3. the managed-vs-self-managed distinction is UNTOUCHED where it belongs —
 *      the Cellular card still draws `modem-router-signal` with its `Router`
 *      mark and `data-provenance`, and still prints the routerManaged copy.
 *
 * FIXTURE PROVENANCE: the roster mirrors `router-signal.visual.spec.ts`, whose
 * header records that every HiLink/ZTE unit on the bench is SIM-less, so the
 * populated readings are SHAPE-DERIVED (real field names, real per-dialect
 * support, supplied numbers) and are never presented as hardware captures.
 *
 * Determinism: the page socket is proxied and the backend's own `status` /
 * `config` / `netif` / `modems` echoes are DROPPED, so the injected roster is
 * the only truth on screen — the same drop shape `router-signal.visual.spec.ts`
 * uses.
 */

// visual -> e2e -> tests -> frontend -> apps -> CeraUI (repo root). Repo-local
// and gitignored; tests never write above the checkout (root AGENTS.md Rule D).
//
// `CERAUI_EVIDENCE_LABEL` buckets a run (`before` / `after`) so the same spec
// photographs the defect and the fix without a second, drifting copy of it.
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/modem-icon-unification",
	process.env.CERAUI_EVIDENCE_LABEL ?? "current",
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

type Metric =
	| { state: "known"; value: number }
	| { state: "unknown"; reason: string };

const known = (value: number): Metric => ({ state: "known", value });
const unknown = (reason: string): Metric => ({ state: "unknown", reason });
const UNSUPPORTED = unknown("unsupported");

type Signal = Record<string, unknown>;

/** ZTE publishes `signalbar` on a fixed 5-scale + `lte_snr`, and NO `sinr`. */
function zteSignal(over: Signal = {}): Signal {
	return {
		provenance: "zte-goform",
		freshness: "live",
		bars: known(4),
		max_bars: known(5),
		dbm: known(-71),
		rsrp: known(-95),
		rsrq: known(-11),
		snr: known(9),
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

function dongleRow(
	ifname: string,
	name: string,
	signal: Signal,
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
			signal,
		},
	};
}

/** A NetworkManager-managed radio, so both classes are photographed together. */
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

/**
 * The operator's exact report: a managed radio, a self-managed dongle with a
 * STRONG reading, and a self-managed dongle with a WEAK one — three rows in one
 * bond. Before the fix the two dongles drew an identical muted fallback, which
 * is why the roster carries two different tiers rather than one dongle.
 */
const ROSTER: Record<string, unknown> = {
	"radio-mm": MM_RADIO,
	"dongle-zte": dongleRow("enx344b50000000", "ZTE MF79U", zteSignal()),
	"dongle-ufi": dongleRow("enx020754023235", "Qualcomm 9024", ufiSignal()),
};

const NETIF: Record<string, unknown> = {
	wwan0: { ip: "10.0.0.5", tp: 4, enabled: true },
	enx344b50000000: { ip: "192.168.0.169", tp: 12, enabled: true },
	enx020754023235: { ip: "192.168.100.2", tp: 3, enabled: true },
};

// ── Locators ─────────────────────────────────────────────────────────────────

const bondedPanel = (page: Page): Locator =>
	page
		.locator("section")
		.filter({ has: page.getByTestId("bonded-link-card") })
		.first();

const bondedCard = (page: Page, ifname: string): Locator =>
	page.locator(`[data-testid="bonded-link-card"][data-link-id="${ifname}"]`);

const cellularSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("modem-row") }).first();

/**
 * The bar cluster the shared indicator draws. `data-link-level` is emitted ONLY
 * by the bar/glyph box branch, and `[data-bar]` only inside the cluster itself,
 * so counting filled bars answers "did this row draw the shared cluster" without
 * reading a class name a CSS regression would walk straight through.
 */
const linkGlyph = (page: Page, ifname: string): Locator =>
	bondedCard(page, ifname).locator("[data-link-level]");

async function filledBars(page: Page, ifname: string): Promise<number> {
	return await linkGlyph(page, ifname)
		.locator('[data-bar="filled"]')
		.count();
}

type Condition = {
	readonly name: string;
	readonly project: "desktop" | "mobile";
	readonly viewport: { width: number; height: number };
};

const CONDITIONS: readonly Condition[] = [
	{
		name: "1280",
		project: "desktop",
		viewport: { width: 1280, height: 900 },
	},
	{ name: "768", project: "desktop", viewport: { width: 768, height: 900 } },
	{ name: "375", project: "mobile", viewport: { width: 375, height: 812 } },
];

for (const condition of CONDITIONS) {
	test.describe(`@visual bonded-link signal glyph — ${condition.name}`, () => {
		const shot = (surface: string): string =>
			path.join(EVIDENCE_DIR, `${surface}-${condition.name}.png`);

		// A cold Vite worker compiles the whole Network destination inside this
		// hook, which alone can outrun the 30 s default before a single assertion
		// runs. The budget bounds the SUITE, not the surface, so raise it here
		// rather than weakening any wait below.
		test.setTimeout(120_000);

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

			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");

			serverConfig();
			send({ netif: NETIF });
			send({ status: { modems: ROSTER } });

			await expect(bondedPanel(page)).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("bonded-link-card")).toHaveCount(3);
		});

		test(
			"every bonded modem draws the SAME glyph, managed or self-managed",
			{ tag: "@visual" },
			async ({ page }) => {
				// Photographed BEFORE the assertions so a failing (pre-fix) run still
				// leaves the evidence this change is judged on.
				await bondedPanel(page).screenshot({ path: shot("bonded-links") });

				// (1) One component, three rows. `data-link-level` is the bar-cluster
				// branch's own marker; a fallback glyph box carries it too, which is
				// why the bar COUNT below is what separates them.
				for (const ifname of [
					"wwan0",
					"enx344b50000000",
					"enx020754023235",
				]) {
					await expect(linkGlyph(page, ifname)).toHaveCount(1);
				}

				// (2) Each row's bar count follows its OWN instrument's reading:
				// the managed radio's 71% and the ZTE's 4-of-5 both read strong;
				// the UFI's -96 dBm reads weak. A dongle drawing the muted fallback
				// (the defect) has ZERO filled bars, so a weak-but-present reading
				// is exactly what a vacuous pass would look like — hence two tiers.
				expect(await filledBars(page, "wwan0")).toBe(3);
				expect(await filledBars(page, "enx344b50000000")).toBe(3);
				expect(await filledBars(page, "enx020754023235")).toBe(1);
			},
		);

		test(
			"the managed / self-managed distinction survives on the Cellular card",
			{ tag: "@visual" },
			async ({ page }) => {
				const section = cellularSection(page);
				await expect(section).toBeVisible({ timeout: 15_000 });
				await section.screenshot({ path: shot("cellular-card") });

				// (3) The dongle keeps its OWN instrument chip, with the `Router`
				// mark and the provenance a bonded bar cluster deliberately does not
				// carry — this pass unified a GLYPH, never the capability model.
				const zte = page.locator(
					'[data-testid="modem-row"][data-modem-id="dongle-zte"]',
				);
				const chip = zte.getByTestId("modem-router-signal");
				await expect(chip).toBeVisible();
				await expect(chip).toHaveAttribute("data-provenance", "zte-goform");
				await expect(chip).toHaveAttribute("data-signal-state", "reading");
				// …and the MM glyph is still the OTHER branch, never both on one row.
				await expect(zte.getByTestId("modem-signal")).toHaveCount(0);

				const mm = page.locator(
					'[data-testid="modem-row"][data-modem-id="radio-mm"]',
				);
				await expect(mm.getByTestId("modem-signal")).toBeVisible();
				await expect(mm.getByTestId("modem-router-signal")).toHaveCount(0);
			},
		);
	});
}
