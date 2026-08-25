import path from "node:path";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the NetworkView per-interface stack (WiFi → Cellular →
 * Ethernet), measured top-of-WiFi to bottom-of-Ethernet.
 *
 * This spec was written to prove Task 19 + Task 20's one-off compaction: "≥40%
 * shorter than the pre-change stack". That ratio stopped being true long ago,
 * and a cap expressed as a fraction of a 2026-07 constant cannot describe a
 * surface that has legitimately grown since. It is now a BUDGET — a ceiling that
 * catches UNREVIEWED growth, rebased on a fresh measurement whenever growth is
 * reviewed. Measured ladder (desktop 1280×800, MOCK_SCENARIO=multi-modem-wifi):
 *
 *   1189 px  8aaa7f08^        pre-Task-19/20 "old" stack (historical record)
 *    703 px  8aaa7f08         post-Task-19/20, the 40.9% reduction it proved
 *   1030 px  2e0fb3be         origin/main at this branch's merge-base — ALREADY
 *                             44% over the 713.4 px cap, unobserved because
 *                             @visual is grep-inverted out of the CI e2e lane
 *   1174 px  7ddcea8d..HEAD   this branch
 *
 * Worth stating plainly: 1174 is 15 px under the 1189 px pre-compaction stack, so
 * Task 19/20's 40.9% saving is now spent. The next reviewed growth here should be
 * a compaction decision, not another rebase.
 *
 * The +144 px is todo 14 (8f37fa1e — WifiSection's station|hotspot|hybrid mode
 * selector, WifiModeBadge, station-lock reason line) and todo 15 (c30a8b60 —
 * EthernetSection's uplink|shared-lan role selector and bond-exclusion
 * explanation). Todo 16 (28647dae) measured 0 px net. Todo 13's Internet-Sharing
 * surface contributes nothing and never can: SharingSection mounts ABOVE
 * WifiSection, outside this span by construction.
 *
 * Compaction was considered and rejected: the only material savings left are the
 * disabled-with-reason lines both surfaces must keep visible (the kiosk
 * touchscreen cannot hover to reveal a `title`), and trading a hard honesty
 * invariant for pixels is the wrong direction.
 *
 * PNG lands in apps/frontend/test-results/task-24-visual (repo-local, gitignored).
 */

const TASK24_DIR = path.resolve(import.meta.dirname, "../../../test-results/task-24-visual");

// Rebase ONLY with a written justification naming what grew, as the header does.
const MEASURED_STACK_HEIGHT_PX = 1174;

// Half a `text-xs` line box (Tailwind v4: 0.75rem/1rem ⇒ 16 px), so one added
// line of copy still trips the budget. Absorbs sub-pixel flex rounding only —
// the measurement was bit-identical across five runs on three commits.
const GROWTH_HEADROOM_PX = 8;

const MAX_NEW_HEIGHT_PX = MEASURED_STACK_HEIGHT_PX + GROWTH_HEADROOM_PX;

test.describe("@visual NetworkView density", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the sections");
	});

	test("three per-interface sections stay within the reviewed height budget", { tag: "@visual" }, async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");

		const section = (name: string) =>
			page.getByRole("heading", { name, level: 2 }).locator("xpath=ancestor::section[1]");

		const wifi = section("WiFi");
		const cellular = page.getByRole("heading", { name: "Cellular", level: 2 });
		const ethernet = section("Ethernet");
		await expect(wifi).toBeVisible();
		await expect(cellular).toBeVisible();
		await expect(ethernet).toBeVisible();

		// Combined bounding box: top of the WiFi section to the bottom of Ethernet.
		const wifiBox = await wifi.boundingBox();
		const ethBox = await ethernet.boundingBox();
		expect(wifiBox).not.toBeNull();
		expect(ethBox).not.toBeNull();
		const top = wifiBox!.y;
		const bottom = ethBox!.y + ethBox!.height;
		const height = Math.round(bottom - top);

		expect(height).toBeLessThanOrEqual(MAX_NEW_HEIGHT_PX);

		// Screenshot exactly the compacted stack (WiFi through Ethernet). fullPage
		// so the clip captures rows below the fold, not a clamped viewport sliver.
		await page.screenshot({
			path: path.join(TASK24_DIR, "network-density.png"),
			fullPage: true,
			clip: { x: wifiBox!.x, y: top, width: wifiBox!.width, height: bottom - top },
		});
	});
});
