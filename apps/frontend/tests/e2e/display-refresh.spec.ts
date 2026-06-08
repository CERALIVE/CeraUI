import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath } from "./helpers/index.js";

/**
 * Task 12 — manual e-ink refresh affordance + requestDisplayRefresh() hook.
 *
 * Proves, against the REAL rendered app, the contract implemented in
 * `DisplayRefresh.svelte` (mounted once at the MainView root via
 * `HudRegion affordance`) + `display-refresh.svelte.ts`:
 *
 *   - The refresh control is HIDDEN under the `lcd` profile (no DOM node) and
 *     VISIBLE + functional under `eink`. A tap drives requestDisplayRefresh(),
 *     observed via the monotonic `window.__ceraDisplayRefreshCount` seam.
 *   - NOTHING auto-refreshes: with no interaction the count stays put for 5s
 *     (the e-ink freeze must never be released on a timer). Proven by waiting
 *     for an increment that must never arrive.
 *
 * The control lives inside the authenticated shell, so each test authenticates.
 * Single-engine (chromium) and desktop-only so the evidence files write once.
 */

const REFRESH = "display-refresh";

test.describe("manual e-ink refresh affordance (Task 12)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine contract proof (cage/Chromium parity)",
	);

	test("hidden on lcd, visible + functional on eink", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		const control = page.getByTestId(REFRESH);

		// 1. lcd profile: the control must not be rendered at all.
		await page.goto("/?display=lcd");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("data-display", "lcd");
		await expect(control).toHaveCount(0);
		const hiddenOnLcd = (await control.count()) === 0;

		// 2. eink profile: exactly one control, visible and enabled.
		await page.goto("/?display=eink");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("data-display", "eink");
		await expect(control).toHaveCount(1);
		await expect(control).toBeVisible();
		await expect(control).toBeEnabled();
		const visibleOnEink = await control.isVisible();

		// 3. Functional: each tap increments the refresh count (drives the hook
		//    that re-pulls state + releases the freeze for one render).
		const before = await page.evaluate(
			() => window.__ceraDisplayRefreshCount ?? 0,
		);
		await control.click();
		await control.click();
		await expect
			.poll(() => page.evaluate(() => window.__ceraDisplayRefreshCount ?? 0), {
				message: "tapping refresh should drive requestDisplayRefresh()",
			})
			.toBe(before + 2);
		const after = await page.evaluate(
			() => window.__ceraDisplayRefreshCount ?? 0,
		);

		const pass = hiddenOnLcd && visibleOnEink && after === before + 2;

		fs.writeFileSync(
			evidencePath("task-12-refresh.txt"),
			[
				"Task 12 — manual e-ink refresh affordance",
				"",
				"Scenario: load /?display=lcd then /?display=eink (authed shell).",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				`lcd profile  — control count = ${hiddenOnLcd ? 0 : "≥1"} (expect: 0, hidden)`,
				`eink profile — control visible = ${visibleOnEink} (expect: true)`,
				`eink profile — control count   = 1 (single mount, not double)`,
				"",
				"Functional tap:",
				`  __ceraDisplayRefreshCount before = ${before}`,
				`  after 2 taps                     = ${after} (expect: ${before + 2})`,
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(pass).toBe(true);
	});

	test("no auto-refresh: count stays put for 5s without interaction", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		await page.goto("/?display=eink");
		await ensureAuthenticated(page);
		await expect(page.getByTestId(REFRESH)).toBeVisible();

		const baseline = await page.evaluate(
			() => window.__ceraDisplayRefreshCount ?? 0,
		);

		// Wait for an auto-increment that must NEVER arrive. If the freeze were
		// released on a timer, the count would climb and waitForFunction would
		// resolve early — so a 5s timeout (rejection) is the PASS. No sleep.
		let autoRefreshed = false;
		try {
			await page.waitForFunction(
				(base) => (window.__ceraDisplayRefreshCount ?? 0) > base,
				baseline,
				{ timeout: 5000, polling: 250 },
			);
			autoRefreshed = true;
		} catch {
			autoRefreshed = false;
		}

		const afterWindow = await page.evaluate(
			() => window.__ceraDisplayRefreshCount ?? 0,
		);
		const pass = !autoRefreshed && afterWindow === baseline;

		fs.writeFileSync(
			evidencePath("task-12-no-auto.txt"),
			[
				"Task 12 — no auto-refresh (e-ink freeze is never released on a timer)",
				"",
				"Scenario: load /?display=eink, then observe for 5s with NO interaction.",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				`  __ceraDisplayRefreshCount baseline = ${baseline}`,
				`  after 5s, no interaction           = ${afterWindow} (expect: ${baseline})`,
				`  auto-refresh observed              = ${autoRefreshed} (expect: false)`,
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(autoRefreshed).toBe(false);
		expect(afterWindow).toBe(baseline);
	});
});
