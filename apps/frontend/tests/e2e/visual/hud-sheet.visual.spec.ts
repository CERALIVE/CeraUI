import fs from "node:fs";
import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated } from "../helpers/index.js";
import { probeContainment } from "../helpers/modem-containment.js";

/**
 * @visual evidence for the reflowed HUD status sheet (Task 8 + Task 18).
 *
 * The sheet renders ONE lifecycle-keyed verdict line + a single sensors line,
 * and mounts the bond constellation only while live. This spec captures each of
 * the three explicit lifecycle states the reflow introduced:
 *
 *   • live    — is_streaming forced true via the WS proxy (the mock never
 *               streams); subtitle data-state=live, constellation strip present.
 *   • idle    — the default idle mock; subtitle data-state=idle, no constellation.
 *   • offline — the WS is dropped and kept down so the HUD staleness clock ages
 *               past STALE_THRESHOLD_MS (5 s); subtitle data-state=offline,
 *               verdict "No signal", last-seen line present.
 *
 * PNGs land in apps/frontend/test-results/task-24-visual (repo-local, gitignored).
 */

const TASK24_DIR = path.resolve(import.meta.dirname, "../../../test-results/task-24-visual");
const WS_PATTERN = /:(3002|31\d\d|6173|8090|8091)\//;

async function openHud(page: Page): Promise<Page> {
	await page.locator("[data-hud-region]").first().click();
	await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
	return page;
}

test.describe("@visual HUD status sheet lifecycle", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");
	});

	test("live: verdict + constellation strip + one sensors line", { tag: "@visual" }, async ({ page }) => {
		await page.routeWebSocket(WS_PATTERN, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status) {
						frame.status.is_streaming = true;
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
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "live");
		await expect(dialog.getByTestId("hud-constellation")).toBeVisible();
		// The reflow collapses the three sensor rows into exactly ONE inline line.
		await expect(dialog.getByTestId("hud-sensors-line")).toHaveCount(1);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-live.png") });
	});

	test("idle: idle verdict, no constellation, one sensors line", { tag: "@visual" }, async ({ page }) => {
		// No proxy — the default mock scenario is idle (is_streaming=false).
		await page.goto("/");
		await ensureAuthenticated(page);
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "idle");
		await expect(dialog.getByTestId("hud-constellation")).toHaveCount(0);
		await expect(dialog.getByTestId("stream-health-state")).toContainText("Idle");
		await expect(dialog.getByTestId("hud-sensors-line")).toHaveCount(1);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-idle.png") });
	});

	test("offline: no-signal verdict once the connection ages out", { tag: "@visual" }, async ({ page }) => {
		let pageWs: WebSocketRoute | null = null;
		let killed = false;
		await page.routeWebSocket(WS_PATTERN, (ws) => {
			// Once killed, refuse every (re)connection so the client stays down and
			// its connectionLostAt ages past STALE_THRESHOLD_MS → isFullyStale.
			if (killed) {
				ws.close();
				return;
			}
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => ws.send(m));
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "idle");

		// Drop the socket and keep it down; the open sheet re-derives reactively.
		killed = true;
		(pageWs as WebSocketRoute | null)?.close();

		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "offline", {
			timeout: 15_000,
		});
		await expect(dialog.getByTestId("stream-health-state")).toContainText("No signal");
		await expect(dialog.getByTestId("hud-constellation")).toHaveCount(0);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-offline.png") });
	});
});

/**
 * design-pass-26 — the COMPACT strip, at every width.
 *
 * Two refinements, one budget. The ceiling used to be introduced by a bare
 * slash (`1.6 Mbps / 4.5 Mbps`), which reads as a fraction — the exact operator
 * report `StreamTelemetryStrip` already fixed with an `aria-hidden` middot. And
 * the health REASON was `hidden sm:inline`, so below 640px the strip stated a
 * verdict and withheld its cause on the one layout where the dock HUD is the
 * only place outside the sheet that could carry it.
 *
 * The reason now drops onto its own muted line under the badge below `sm`, and
 * it does so INSIDE the strip's own `h-12` box — the mobile dock is a fixed
 * `--mobile-dock-height` that `<main>` reserves padding against and the toast
 * stack offsets above, so growing it would silently break both. That invariant
 * is what this spec measures; jsdom can only see the class list.
 *
 * Three viewports, the C4 capture convention: 1280x900 desktop, 1024x600 in
 * `?mode=touch` applied at NAVIGATION (the modem-ux precedent — a layout mode
 * set after load measures the pre-lift geometry), and 375x812 mobile. PNGs land
 * in the gitignored `test-results/design-pass/26/` (Rule D: repo-local).
 */

const DESIGN_PASS_26_DIR = path.resolve(
	import.meta.dirname,
	"../../../test-results/design-pass/26",
);

/** Tailwind's `sm`. Below it the reason stacks; from it up the reason is inline. */
const SM_BREAKPOINT_PX = 640;

/**
 * Every `hud-`-prefixed testid the compact strip may carry (AGENTS.md → "HUD
 * 4-fact scope"). The unit twin of this list is `STRIP_HUD_TESTIDS` in
 * `src/main/HudBar.test.ts`; both must move together or the budget has a hole.
 */
const STRIP_HUD_TESTIDS = [
	"hud-bitrate",
	"hud-bitrate-limit",
	"hud-bitrate-target",
] as const;

/** A degraded rollup with a cause — the only state that renders the reason. */
const DEGRADED_HEALTH = {
	state: "degraded",
	reason: { component: "frames", detail: "No frames advancing" },
	process: { alive: true },
	frames: { advancing: false, count: 0 },
	srt: { reconnecting: false, reconnectCount: 0 },
	bond: { linkCount: 2, activeLinks: 1 },
} as const;

type StripCondition = {
	readonly name: string;
	readonly project: "desktop" | "mobile";
	readonly viewport: { width: number; height: number };
	readonly touch: boolean;
};

const STRIP_CONDITIONS: readonly StripCondition[] = [
	{ name: "desktop-1280x900", project: "desktop", viewport: { width: 1280, height: 900 }, touch: false },
	{ name: "touch-1024x600", project: "desktop", viewport: { width: 1024, height: 600 }, touch: true },
	{ name: "mobile-375x812", project: "mobile", viewport: { width: 375, height: 812 }, touch: false },
];

type StripGeometry = {
	readonly stripHeight: number;
	readonly reasonRendered: boolean;
	readonly reasonPainted: boolean;
	readonly reasonText: string;
	readonly reasonStackedUnderVerdict: boolean;
	readonly reasonInsideStrip: boolean;
	readonly hudTestIds: readonly string[];
	readonly limitText: string | null;
	readonly dock: { readonly found: boolean; readonly height: number; readonly budget: number };
};

for (const condition of STRIP_CONDITIONS) {
	test.describe(`@visual design-pass-26 — HUD compact strip (${condition.name})`, () => {
		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);
		});

		test(
			"the reason is readable at this width, the ceiling carries no slash, and the dock did not grow",
			{ tag: "@visual" },
			async ({ page }) => {
				let route: WebSocketRoute | null = null;
				await page.routeWebSocket(WS_PATTERN, (ws) => {
					route = ws;
					const server = ws.connectToServer();
					ws.onMessage((m) => server.send(m));
					server.onMessage((m) => {
						const text = typeof m === "string" ? m : m.toString();
						try {
							const frame = JSON.parse(text) as {
								status?: Record<string, unknown>;
								health?: unknown;
							};
							// The device's own health verdict is DROPPED so the injected one
							// below is authoritative — the mock is idle and cannot degrade.
							if (frame?.health !== undefined) return;
							if (frame?.status) {
								frame.status.is_streaming = true;
								frame.status.engine_bitrate = { applied_kbps: 3000 };
								ws.send(JSON.stringify(frame));
								return;
							}
						} catch {
							/* non-JSON / binary frame */
						}
						ws.send(m);
					});
				});

				await page.setViewportSize(condition.viewport);
				await page.goto(condition.touch ? "/?mode=touch" : "/");
				await ensureAuthenticated(page);

				const strip = page.locator("[data-hud-region]").first();
				await expect(strip).toBeVisible({ timeout: 20_000 });

				(route as WebSocketRoute | null)?.send(JSON.stringify({ health: DEGRADED_HEALTH }));
				// ATTACHED, not visible: on the pre-change tree the reason is in the DOM
				// carrying `hidden`, and this same spec must still produce its BEFORE
				// evidence there. Whether it is PAINTED is assertion 1's job.
				await expect(page.getByTestId("stream-health-reason")).toBeAttached({ timeout: 15_000 });

				fs.mkdirSync(DESIGN_PASS_26_DIR, { recursive: true });
				// Capture BEFORE asserting: on the pre-change tree the assertions below
				// are RED, and a screenshot taken after a failed assertion never exists.
				await strip.screenshot({
					path: path.join(DESIGN_PASS_26_DIR, `hud-strip-${condition.name}.png`),
				});

				const geometry = await page.evaluate<StripGeometry>(() => {
					const stripEl = document.querySelector("[data-hud-region]");
					if (stripEl === null) throw new Error("HUD compact strip is not mounted");
					const stripRect = stripEl.getBoundingClientRect();

					const reasonEl = document.querySelector('[data-testid="stream-health-reason"]');
					const verdictEl = document.querySelector('[data-testid="stream-health"]');
					const reasonRect = reasonEl?.getBoundingClientRect() ?? null;
					const verdictRect = verdictEl?.getBoundingClientRect() ?? null;

					// The dock is whatever fixed ancestor carries the strip; measured
					// against a probe of the token itself so the unit stays irrelevant.
					const probe = document.createElement("div");
					probe.style.cssText =
						"position:absolute;visibility:hidden;height:var(--mobile-dock-height)";
					document.body.append(probe);
					const budget = probe.getBoundingClientRect().height;
					probe.remove();

					let dockEl: Element | null = null;
					for (let node = stripEl.parentElement; node !== null; node = node.parentElement) {
						if (getComputedStyle(node).position === "fixed") {
							dockEl = node;
							break;
						}
					}

					const limitEl = document.querySelector('[data-testid="hud-bitrate-limit"]');

					return {
						stripHeight: stripRect.height,
						reasonRendered: reasonEl !== null,
						reasonPainted:
							reasonEl !== null &&
							reasonRect !== null &&
							reasonRect.height > 0 &&
							getComputedStyle(reasonEl).display !== "none" &&
							getComputedStyle(reasonEl).visibility !== "hidden",
						reasonText: reasonEl?.textContent?.trim() ?? "",
						reasonStackedUnderVerdict:
							reasonRect !== null && verdictRect !== null && reasonRect.top >= verdictRect.bottom - 1,
						reasonInsideStrip:
							reasonRect !== null &&
							reasonRect.top >= stripRect.top - 1 &&
							reasonRect.bottom <= stripRect.bottom + 1,
						hudTestIds: [
							...new Set(
								[...stripEl.querySelectorAll('[data-testid^="hud-"]')].map(
									(el) => el.getAttribute("data-testid") ?? "",
								),
							),
						].sort(),
						limitText: limitEl?.textContent?.trim() ?? null,
						dock: {
							found: dockEl !== null,
							height: dockEl?.getBoundingClientRect().height ?? 0,
							budget,
						},
					};
				});

				fs.writeFileSync(
					path.join(DESIGN_PASS_26_DIR, `strip-${condition.name}.json`),
					`${JSON.stringify(geometry, null, 2)}\n`,
					"utf8",
				);

				// ── 1. The cause is on screen at THIS width ──────────────────────────
				expect(
					geometry.reasonRendered,
					`${condition.name}: the strip states a verdict but renders no cause`,
				).toBe(true);
				expect(
					geometry.reasonPainted,
					`${condition.name}: the reason is in the DOM but not painted — the retired \`hidden sm:inline\` behaviour`,
				).toBe(true);
				expect(geometry.reasonText).toContain("No frames advancing");

				// ── 2. …on its own line below `sm`, inline from `sm` up ──────────────
				// Asserted in BOTH directions, so the responsive switch cannot silently
				// collapse into one arm.
				expect(
					geometry.reasonStackedUnderVerdict,
					`${condition.name}: the reason must stack under the badge below ${SM_BREAKPOINT_PX}px and sit inline above it`,
				).toBe(condition.viewport.width < SM_BREAKPOINT_PX);

				// ── 3. …and it stays INSIDE the strip's own box ──────────────────────
				expect(
					geometry.reasonInsideStrip,
					`${condition.name}: the reason line escaped the strip's box`,
				).toBe(true);
				expect(
					geometry.stripHeight,
					`${condition.name}: the strip grew past its h-12 box (${geometry.stripHeight}px)`,
				).toBeLessThanOrEqual(48.5);

				// ── 4. …so the mobile dock never outgrows its own token ──────────────
				if (condition.project === "mobile") {
					expect(
						geometry.dock.found,
						`${condition.name}: the mobile dock must exist, or this leg proves nothing`,
					).toBe(true);
					expect(
						geometry.dock.height,
						`${condition.name}: the dock is ${geometry.dock.height}px against a --mobile-dock-height budget of ${geometry.dock.budget}px; <main>'s reserved padding and the toast offset both read that token`,
					).toBeLessThanOrEqual(geometry.dock.budget);
				}

				// ── 5. The ceiling is separated by a middot, never a slash ───────────
				// Conditional because the throttled state depends on the device's own
				// engine_bitrate; the unconditional DOM lock is HudBar.test.ts's.
				if (geometry.limitText !== null) {
					expect(
						geometry.limitText,
						`${condition.name}: the configured limit still travels behind a slash, which reads as a fraction`,
					).not.toContain("/");
				}

				// ── 6. The four-fact budget still holds ──────────────────────────────
				const overBudget = geometry.hudTestIds.filter(
					(id) => !(STRIP_HUD_TESTIDS as readonly string[]).includes(id),
				);
				expect(
					overBudget,
					`${condition.name}: the compact strip grew a fifth fact: ${overBudget.join(", ")}`,
				).toEqual([]);

				// ── 7. No horizontal overflow at this viewport (BP-1) ────────────────
				const containment = await probeContainment(page);
				expect(
					containment.documentOverflowPx,
					`${condition.name}: the document overflows horizontally by ${containment.documentOverflowPx}px. Widest offenders:\n${containment.overflowSources.join("\n")}`,
				).toBeLessThanOrEqual(1);
			},
		);
	});
}
