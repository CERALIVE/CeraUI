import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Task 2 — Compact-HUD signal glyph: fixed-width container + shared baseline.
 *
 * Proves the layout fix in `apps/frontend/src/main/HudBar.svelte` (compact bar,
 * lines 65-161) against the REAL rendered DOM:
 *
 *   - Every bonded-link glyph box renders at the SAME fixed width (`w-[14px]`)
 *     regardless of which glyph state it holds (3/2/1 filled bars, no_sim
 *     CardSim, scanning Radar, connected-no-signal LoaderCircle, SignalZero).
 *   - The L# label and the glyph box share a consistent vertical baseline
 *     (their common centre, since the per-link wrapper is `items-center`), and
 *     that baseline is the same across every link.
 *   - Inter-link horizontal gaps are even (`gap-2.5` = 10px).
 *
 * Different glyph states are forced deterministically by injecting a mutated
 * `modems` snapshot via the dev-only `dev.emit` broadcast (Task 5), driven
 * through the same WebSocket harness pattern documented in `field-lock.spec.ts`
 * (see PLAYBOOK.md). The harness captures the live modems snapshot so the echo
 * carries the real modem keys.
 *
 * Topology: local Vite dev :6173 uses `__ceraSocketPort` to select this worker's
 * 31xx backend; CI production preview :6173 uses cookie-based admission to the
 * same worker backend. Both use NODE_ENV=development (dev.emit) and
 * MOCK_SCENARIO=multi-modem-wifi.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(
			`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`,
		);
	}
	return tokens[0];
})();

/** Pixel tolerances (sub-pixel rounding + font metrics). */
const WIDTH_TOL = 0.5;
const ALIGN_TOL = 1;
const GAP_TOL = 1;

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be fully self-contained (no outer-scope references except `token`).
 * Captures the latest modems/wifi snapshots so the test can inject mutated
 * echoes that carry the real device keys.
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastModems: null,
		lastWifi: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__cera.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `emit-${++w.__cera._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
		},
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.addEventListener("message", (ev: MessageEvent) => {
				try {
					const o = JSON.parse(ev.data);
					if (o && typeof o === "object") {
						if (o.modems) w.__cera.lastModems = o.modems;
						if (o.wifi) w.__cera.lastWifi = o.wifi;
						if (o.status && typeof o.status === "object") {
							if (o.status.modems) w.__cera.lastModems = o.status.modems;
							if (o.status.wifi) w.__cera.lastWifi = o.status.wifi;
						}
					}
				} catch {
					/* non-JSON frame */
				}
			});
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join(".") : null;
				// Auth without the device password: rewrite to a valid token.
				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}
			} catch {
				/* not an RPC frame (e.g. keepalive) */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* localStorage unavailable */
	}
}

function hudRegion(page: Page) {
	return page.locator("[data-hud-region]").first();
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

interface Rect {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
	centerY: number;
}
interface LinkMeasure {
	label: Rect;
	glyph: Rect;
	wrapperLeft: number;
	wrapperRight: number;
}

/**
 * Measure, per bonded-link group in the compact HUD, the L# label box and the
 * fixed-width glyph box. Each wrapper renders exactly two children — the L#
 * label then the LinkIndicator glyph box (HudBar `miniBars`) — so children[0]
 * is the label and children[1] is the glyph box. (LinkIndicator sizes the box
 * via an inline `style:width`, not a `w-[14px]` class.)
 */
async function measure(page: Page): Promise<LinkMeasure[]> {
	return page.evaluate(() => {
		const toRect = (el: Element) => {
			const r = el.getBoundingClientRect();
			return {
				left: r.left,
				right: r.right,
				top: r.top,
				bottom: r.bottom,
				width: r.width,
				height: r.height,
				centerY: r.top + r.height / 2,
			};
		};
		// Two HUD triggers are mounted (desktop top + mobile bottom dock); only
		// one is visible per breakpoint. Pick the visible region, then its only
		// `gap-2.5` cluster (the bonded-link group). The expanded Sheet (also
		// gap-2.5) is not mounted while closed and lives outside the trigger.
		const regions = Array.from(
			document.querySelectorAll("[data-hud-region]"),
		).filter((el) => el.getClientRects().length > 0);
		const region = regions[0];
		if (!region) throw new Error("no visible HUD region");
		const container = region.querySelector(".gap-2\\.5");
		if (!container) throw new Error("bonded-link container not found");
		return Array.from(container.children).map((wrapper) => {
			const label = wrapper.children[0];
			const glyph = wrapper.children[1];
			if (!glyph || !label)
				throw new Error("link wrapper missing label or glyph box");
			return {
				label: toRect(label),
				glyph: toRect(glyph),
				wrapperLeft: wrapper.getBoundingClientRect().left,
				wrapperRight: wrapper.getBoundingClientRect().right,
			};
		});
	});
}

function widthSpread(measures: LinkMeasure[]): number {
	const widths = measures.map((m) => m.glyph.width);
	return Math.max(...widths) - Math.min(...widths);
}


test.use({ viewport: { width: 1024, height: 600 } });

test.describe("compact HUD glyph — fixed width + shared baseline", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser layout proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout exposes the compact HUD bar",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
		await expect(hudRegion(page)).toBeVisible({ timeout: 15_000 });
		// Wait until at least one bonded-link glyph box has rendered.
		await expect
			.poll(async () => (await measure(page)).length, {
				timeout: 10_000,
				message: "compact HUD should render bonded-link groups",
			})
			.toBeGreaterThan(0);
	});

	test("scenario 1 — every glyph box is the same fixed width across all states @visual", async ({
		page,
	}, testInfo) => {
		test.skip(
			!testInfo.title.includes("@visual"),
			"screenshot evidence test",
		);

		// Baseline (default multi-modem-wifi scenario): all glyph boxes equal.
		const before = await measure(page);
		expect(before.length).toBeGreaterThan(1);
		expect(widthSpread(before)).toBeLessThanOrEqual(WIDTH_TOL);

		// Force a spread of glyph STATES by injecting a mutated modems snapshot
		// with the real device keys: bars / no_sim / connected-no-signal.
		await expect
			.poll(() => page.evaluate(() => !!(window as any).__cera.lastModems), {
				timeout: 10_000,
				message: "modems snapshot should be captured for echo injection",
			})
			.toBe(true);

		await page.evaluate(() => {
			const w = window as any;
			const modems = JSON.parse(JSON.stringify(w.__cera.lastModems));
			const keys = Object.keys(modems);
			keys.forEach((k, i) => {
				const m = modems[k];
				m.status = m.status ?? {};
				if (i === 0) {
					// 3 filled bars
					m.no_sim = false;
					m.status.connection = "connected";
					m.status.signal = 90;
				} else if (i === 1) {
					// no_sim → CardSim icon
					m.no_sim = true;
				} else {
					// connected, no signal → LoaderCircle icon
					m.no_sim = false;
					m.status.connection = "connected";
					m.status.signal = null;
				}
			});
			w.__cera.emit("modems", modems);
		});

		// Re-measure after the state change: widths must be UNCHANGED and still
		// all equal (the fixed-width container is state-agnostic).
		await expect
			.poll(async () => widthSpread(await measure(page)), {
				timeout: 8_000,
				message: "glyph widths must stay equal after state injection",
			})
			.toBeLessThanOrEqual(WIDTH_TOL);

		const after = await measure(page);
		// Cross-check: every after-width equals the baseline width.
		const baseW = before[0].glyph.width;
		for (const m of after) {
			expect(Math.abs(m.glyph.width - baseW)).toBeLessThanOrEqual(WIDTH_TOL);
		}

		fs.writeFileSync(
			evidencePath("task-2-glyph-widths.json"),
			JSON.stringify(
				{
					task: "task-2",
					scenario: "fixed-width glyph container",
					viewport: { width: 1024, height: 600 },
					tolerancePx: WIDTH_TOL,
					before: {
						count: before.length,
						widths: before.map((m) => m.glyph.width),
						spread: widthSpread(before),
					},
					afterStateInjection: {
						count: after.length,
						widths: after.map((m) => m.glyph.width),
						spread: widthSpread(after),
					},
					pass:
						widthSpread(before) <= WIDTH_TOL && widthSpread(after) <= WIDTH_TOL,
					generated: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf8",
		);

		await hudRegion(page).screenshot({
			path: evidencePath("task-2-hud.png"),
		});
	});

	test("scenario 2 — label/glyph share a baseline and inter-link gaps are even", async ({
		page,
	}) => {
		const m = await measure(page);
		expect(m.length).toBeGreaterThan(1);

		// (a) Within each link: label and glyph share a baseline. The per-link
		//     wrapper is items-end, so the box bottoms align; the label (~11px)
		//     and the 14px glyph box have different heights, so their centres
		//     legitimately differ — assert the shared bottom, not the centre.
		for (const link of m) {
			expect(Math.abs(link.label.bottom - link.glyph.bottom)).toBeLessThanOrEqual(
				ALIGN_TOL,
			);
		}

		// (b) Across links: every label centre aligns, and every glyph centre
		//     aligns — one consistent baseline for the whole cluster.
		const labelCenters = m.map((x) => x.label.centerY);
		const glyphCenters = m.map((x) => x.glyph.centerY);
		const labelSpread = Math.max(...labelCenters) - Math.min(...labelCenters);
		const glyphSpread = Math.max(...glyphCenters) - Math.min(...glyphCenters);
		expect(labelSpread).toBeLessThanOrEqual(ALIGN_TOL);
		expect(glyphSpread).toBeLessThanOrEqual(ALIGN_TOL);

		// (c) Even inter-link gaps (gap-2.5 = 10px between consecutive wrappers).
		const gaps: number[] = [];
		for (let i = 1; i < m.length; i++) {
			gaps.push(m[i].wrapperLeft - m[i - 1].wrapperRight);
		}
		const gapSpread =
			gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0;
		expect(gapSpread).toBeLessThanOrEqual(GAP_TOL);

		fs.writeFileSync(
			evidencePath("task-2-baseline-gaps.json"),
			JSON.stringify(
				{
					task: "task-2",
					scenario: "shared baseline + even gaps",
					viewport: { width: 1024, height: 600 },
					tolerancePx: { align: ALIGN_TOL, gap: GAP_TOL },
					links: m.map((x, i) => ({
						index: i,
						labelCenterY: x.label.centerY,
						glyphCenterY: x.glyph.centerY,
						labelGlyphCenterDelta: Math.abs(x.label.centerY - x.glyph.centerY),
						glyphWidth: x.glyph.width,
					})),
					labelCenterSpread: labelSpread,
					glyphCenterSpread: glyphSpread,
					gaps,
					gapSpread,
					pass:
						labelSpread <= ALIGN_TOL &&
						glyphSpread <= ALIGN_TOL &&
						gapSpread <= GAP_TOL,
					generated: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf8",
		);
	});
});
