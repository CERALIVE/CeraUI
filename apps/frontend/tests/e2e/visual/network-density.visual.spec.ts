import path from "node:path";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the compacted NetworkView (Task 19 + Task 20).
 *
 * The three per-interface sections (WiFi → Cellular → Ethernet) were reshaped
 * from two-row telemetry cards into single-line identity+control rows, with the
 * per-link telemetry cluster deduped into BondedLinksSection. This spec proves
 * the vertical compaction with BOTH a screenshot and a hard bounding-box height
 * assertion: the combined top-of-WiFi → bottom-of-Ethernet height must be at
 * least 40% shorter than the pre-change stack.
 *
 * OLD_STACK_HEIGHT_PX is a recorded pre-change constant. Origin: measured on this
 * same dev stack (desktop 1280×800, MOCK_SCENARIO=multi-modem-wifi) with the four
 * section files checked out at commit 8aaa7f08^ — i.e. immediately BEFORE Task 19
 * (bonded links) and Task 20 (single-line network rows). The post-change stack
 * measures ~703 px there, a 40.9% reduction.
 *
 * PNG lands in apps/frontend/test-results/task-24-visual (repo-local, gitignored).
 */

const TASK24_DIR = path.resolve(import.meta.dirname, "../../../test-results/task-24-visual");

// Measured at 8aaa7f08^ (pre-Task-19/20), desktop 1280×800, multi-modem-wifi.
const OLD_STACK_HEIGHT_PX = 1189;
// A ≥40% reduction means the new stack must be no taller than 60% of the old.
const MAX_NEW_HEIGHT_PX = OLD_STACK_HEIGHT_PX * 0.6;

test.describe("@visual NetworkView density", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the sections");
	});

	test("three per-interface sections are ≥40% shorter than pre-change", { tag: "@visual" }, async ({ page }) => {
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
