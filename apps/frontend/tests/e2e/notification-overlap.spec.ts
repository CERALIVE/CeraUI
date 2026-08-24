import type { Page } from "@playwright/test";

import { expect, type PageRpc, test } from "./fixtures/index.js";
import { runAxe } from "./helpers/axe.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * A PERSISTENT NOTICE NEVER OWNS A CONTROL'S HIT-TEST POINT — @functional.
 *
 * Task 41's fleet drill on `ceralive2` returned FAIL for exactly this. The
 * persistent duplicate-IP notice (`netif_dup_ip`) rendered as a svelte-sonner
 * toast with `duration: Number.POSITIVE_INFINITY`, i.e. a permanent card at
 * z-index 999999999, and board measurement put its box at:
 *
 *   375x812   toast 16,665 328x132  ·  Settings tab 144,708 72x56   -> covered
 *   768x900   toast 373,745 356x132 ·  Settings tab 301,796 151x56  -> covered
 *   1024x600  toast 629,445 356x132 ·  an 85svh dialog ends at y=555,
 *                                      so its footer is covered from x=629
 *
 * A normal Settings tap timed out for 30 s because the notice, not the nav,
 * answered it — and no amount of waiting recovers a toast that never expires.
 *
 * WHY THIS SPEC IS DELIBERATELY SURFACE-AGNOSTIC
 * ─────────────────────────────────────────────────────────────────────────────
 * It never asks WHERE the notice renders — only that its text is on screen (the
 * warning must not be weakened or hidden) and that no control it overlaps loses
 * its own hit test. That is the actual contract, and it makes the spec a true
 * before/after: it fails on the pre-fix tree because the toast owns those
 * points, and it would fail again if the occlusion merely moved to the in-flow
 * band, because `hitOwner` counts BOTH surfaces as `notice`.
 *
 * `document.elementFromPoint` answers `null` outside the viewport, and
 * `hit.closest(sel) !== null` is `true` for `null` — so the boolean form of this
 * assertion passes VACUOUSLY. `hitOwner` returns a four-value verdict instead,
 * the same discipline `modem-advanced-disclosure.spec.ts` records.
 */

/** Verbatim from the board: the notice text that produced the finding. */
const DUP_IP_TEXT =
	"Interfaces enx0c5b8f279a64, eth1 share the same IP address: 192.168.8.100. " +
	"Per-interface link mapping is not active, so checks that steer by address " +
	"can't tell them apart and only one of them can carry bonded traffic.";

/** The wire shape `network-interfaces.ts` `publishDupIpNotice` broadcasts. */
const DUP_IP_NOTICE = {
	name: "netif_dup_ip",
	type: "warning",
	msg: DUP_IP_TEXT,
	duration: 0,
	is_persistent: true,
	is_dismissable: true,
} as const;

/** Below `DESKTOP_CHROME_QUERY`, so `MainView` mounts the fixed bottom dock. */
const DOCK_VIEWPORTS = [
	{ width: 375, height: 812 },
	{ width: 768, height: 900 },
] as const;

/** Every width the fleet drill measured. */
const DIALOG_VIEWPORTS = [
	{ width: 1024, height: 600 },
	{ width: 768, height: 900 },
	{ width: 375, height: 812 },
] as const;

const DOCK = '[data-testid="dock-nav"]';
const SETTINGS_TAB = "#mobile-nav-tab-settings";
const FOOTER = "[data-app-dialog-footer]";

type HitVerdict = {
	owner: "target" | "notice" | "other" | "nothing";
	testid: string | null;
	tag: string | null;
};

/**
 * Who really answers a click at `(x, y)`.
 *
 * `notice` covers BOTH renderings on purpose — the sonner overlay this fix
 * retires and the in-flow band that replaces it — so the contract cannot be
 * satisfied by moving the occlusion from one surface to the other.
 */
function hitOwner(
	page: Page,
	point: { x: number; y: number },
	targetSelector: string,
): Promise<HitVerdict> {
	return page.evaluate(
		({ x, y, sel }) => {
			const hit = document.elementFromPoint(x, y);
			if (hit === null) {
				return { owner: "nothing", testid: null, tag: null } as HitVerdict;
			}
			const inNotice =
				hit.closest("[data-sonner-toaster]") !== null ||
				hit.closest('[data-testid="persistent-notices"]') !== null;
			const owner =
				hit.closest(sel) !== null ? "target" : inNotice ? "notice" : "other";
			return {
				owner,
				testid:
					hit.closest<HTMLElement>("[data-testid]")?.dataset.testid ?? null,
				tag: hit.tagName.toLowerCase(),
			} as HitVerdict;
		},
		{ x: point.x, y: point.y, sel: targetSelector },
	);
}

async function centreOf(
	page: Page,
	selector: string,
): Promise<{ x: number; y: number }> {
	const box = await page.locator(selector).first().boundingBox();
	if (box === null) throw new Error(`no bounding box for ${selector}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Both renderings arrive with a finite entrance animation, and a hit test taken
 * mid-slide measures the notice where it is not going to stay — that race is
 * what let the pre-fix tree pass the 375 leg. Drain the finite animations, never
 * the infinite skeleton pulses, which would hang.
 */
function settleMotion(page: Page): Promise<void> {
	return page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation.effect?.getComputedTiming().iterations !==
						Number.POSITIVE_INFINITY,
				)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
}

function raiseDupIp(pageRpc: PageRpc): Promise<unknown> {
	return pageRpc.call(["dev", "emit"], {
		type: "notification",
		payload: { show: [DUP_IP_NOTICE] },
	});
}

/** The warning itself must still be on screen — this fix hides nothing. */
async function expectNoticeVisible(page: Page): Promise<void> {
	await expect(page.getByText("share the same IP address").first()).toBeVisible({
		timeout: 15_000,
	});
	await settleMotion(page);
}

async function openModemDialog(page: Page): Promise<void> {
	await page.getByTestId("open-modem-config-dialog").first().click();
	await expect(page.getByRole("dialog").first()).toBeVisible();
	await expect(page.getByRole("dialog").first().locator(FOOTER)).toBeVisible();
	await settleMotion(page);
}

type LayerReport = { notice: number | null; dialog: number | null };

/**
 * The highest stacking layer each surface sits on.
 *
 * A HIT TEST CANNOT ANSWER THE DIALOG CASE, and that is worth stating plainly:
 * bits-ui sets `pointer-events: none` on `<body>` while a modal is open
 * (board-verified here), so `elementFromPoint` skips every overlay outside the
 * dialog and happily returns the button underneath a card that is painted right
 * over it. The occlusion was therefore VISUAL — an operator could not read or
 * confidently press a Save button behind an opaque permanent notice — and only
 * a stacking-layer comparison can see it.
 *
 * Only a POSITIONED ancestor with a numeric z-index forms a layer that can
 * outrank the dialog, so a merely `relative` wrapper is correctly ignored.
 */
function layerReport(page: Page): Promise<LayerReport> {
	return page.evaluate(() => {
		const topLayer = (start: Element | null): number | null => {
			let top: number | null = null;
			for (
				let node: Element | null = start;
				node !== null;
				node = node.parentElement
			) {
				const style = getComputedStyle(node);
				if (style.position === "static") continue;
				const z = Number.parseInt(style.zIndex, 10);
				if (Number.isNaN(z)) continue;
				top = top === null ? z : Math.max(top, z);
			}
			return top;
		};
		return {
			notice: topLayer(
				document.querySelector('[data-testid="persistent-notice"]') ??
					document.querySelector("[data-sonner-toast]"),
			),
			dialog: topLayer(
				document.querySelector(
					'[data-slot="dialog-content"], [data-slot="sheet-content"]',
				),
			),
		};
	});
}

test.describe(
	"a persistent notice never owns a control's hit-test point",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser layout proof",
		);

		test.beforeEach(({}, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"each leg drives its own viewport; run once",
			);
		});

		for (const viewport of DOCK_VIEWPORTS) {
			const label = `${viewport.width}x${viewport.height}`;

			test(`the mobile dock keeps its own hit test at ${label}`, async ({
				page,
				pageRpc,
			}) => {
				await page.setViewportSize(viewport);
				await page.goto("/");
				await ensureAuthenticated(page);
				await navigateTo(page, "live");
				await expect(page.getByTestId("dock-nav")).toBeVisible();

				// `--mobile-dock-height` is the ONE source for the padding `<main>`
				// reserves and the clearance the toast stack is pushed above, so a
				// token that failed to resolve would hide content under the dock
				// AND put the toasts back on it. Measure the consequence, not the
				// class name.
				const reserved = await page.evaluate(() => {
					const main = document.getElementById("main-content");
					const dock = document.querySelector('[data-testid="dock-nav"]')
						?.parentElement;
					if (main === null || !dock) throw new Error("no main / no dock");
					return {
						padding: Number.parseFloat(getComputedStyle(main).paddingBottom),
						dockHeight: dock.getBoundingClientRect().height,
					};
				});
				expect(
					reserved.padding,
					`main reserves ${reserved.padding}px for a ${reserved.dockHeight}px dock at ${label}`,
				).toBeGreaterThanOrEqual(reserved.dockHeight);

				// CONTROL: with nothing raised, the nav owns its own point. An
				// assertion that cannot pass on a healthy layout proves nothing.
				await settleMotion(page);
				const before = await hitOwner(
					page,
					await centreOf(page, SETTINGS_TAB),
					DOCK,
				);
				expect(
					before.owner,
					`control at ${label}: ${JSON.stringify(before)}`,
				).toBe("target");

				await raiseDupIp(pageRpc);
				await expectNoticeVisible(page);

				const after = await hitOwner(
					page,
					await centreOf(page, SETTINGS_TAB),
					DOCK,
				);
				expect(
					after.owner,
					`Settings tab at ${label} is owned by ${JSON.stringify(after)}`,
				).toBe("target");

				// …and an ORDINARY tap really navigates. The hit test above measures
				// the top-most box; this proves the operator's own gesture lands.
				await page.locator(SETTINGS_TAB).click({ timeout: 5_000 });
				await expect(page.locator(SETTINGS_TAB)).toHaveAttribute(
					"aria-current",
					"page",
				);
			});
		}

		for (const viewport of DIALOG_VIEWPORTS) {
			const label = `${viewport.width}x${viewport.height}`;

			test(`dialog actions keep their own hit test at ${label}`, async ({
				page,
				pageRpc,
			}) => {
				await page.setViewportSize(viewport);
				await page.goto("/");
				await ensureAuthenticated(page);
				await navigateTo(page, "network");

				await raiseDupIp(pageRpc);
				await expectNoticeVisible(page);

				// The modem Configure dialog is the surface the drill measured, and
				// the one that matters: it is long enough to reach AppDialog's
				// `max-h-[85svh]`, so its footer sits at the bottom of the viewport
				// exactly where the bottom-anchored toast stack lives. A short dialog
				// never overlaps and would make this leg vacuous.
				await openModemDialog(page);

				const layers = await layerReport(page);
				expect(
					layers.dialog,
					"the dialog is on no stacking layer — nothing to compare against",
				).not.toBeNull();
				expect(
					layers.notice === null || layers.notice < (layers.dialog ?? 0),
					`at ${label} the notice sits on layer ${layers.notice} and the dialog on ${layers.dialog}`,
				).toBe(true);

				// …and the footer's own action really acts. Weaker than the layer
				// comparison above (see `layerReport`) but it is the operator's own
				// gesture, and it fails outright if anything genuinely blocks it.
				const footer = page.getByRole("dialog").first().locator(FOOTER);
				const buttons = footer.locator("button");
				expect(
					await buttons.count(),
					"the dialog footer offered no action to measure",
				).toBeGreaterThan(0);
				await buttons.first().click({ timeout: 5_000 });
				await expect(page.getByRole("dialog")).toHaveCount(0);

				// The warning is still readable — this fix moves the notice off the
				// control layer, it does not silence it.
				await expectNoticeVisible(page);
			});
		}

		test("the in-flow band is accessible on its own terms", async ({
			page,
			pageRpc,
		}) => {
			// `a11y.spec.ts` is page-baselined and can only express "no NEW rule",
			// so it cannot state an absolute zero for one surface — and it never
			// raises a notice, so the band is unmeasured there. This is the scoped
			// gate the band's own live region and list semantics need.
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");
			await raiseDupIp(pageRpc);
			await expectNoticeVisible(page);

			const violations = await runAxe(page, {
				include: ['[data-testid="persistent-notices"]'],
			});
			expect(
				violations,
				`axe on the persistent-notice band: ${JSON.stringify(violations)}`,
			).toEqual([]);
		});

		test("NON-VACUITY — the layer probe really does report an overlay", async ({
			page,
			pageRpc,
		}) => {
			// Every assertion above is an absence, and an absence proves nothing
			// unless the probe can be shown to report the thing it looks for.
			await page.setViewportSize({ width: 1024, height: 600 });
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");
			await raiseDupIp(pageRpc);
			await expectNoticeVisible(page);
			await openModemDialog(page);

			expect((await layerReport(page)).notice).toBeNull();

			// Put the notice back on sonner's own layer and re-ask.
			await page.evaluate(() => {
				const host = document.querySelector<HTMLElement>(
					'[data-testid="persistent-notices"]',
				);
				if (host === null) throw new Error("no notice host to lift");
				host.style.position = "fixed";
				host.style.zIndex = "999999999";
			});

			const lifted = await layerReport(page);
			expect(
				lifted.notice,
				`the probe did not see a z-999999999 overlay: ${JSON.stringify(lifted)}`,
			).toBe(999999999);
			expect(lifted.notice ?? 0).toBeGreaterThan(lifted.dialog ?? 0);
		});
	},
);
