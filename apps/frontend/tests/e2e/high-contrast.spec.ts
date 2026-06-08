import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";
import { evidencePath } from "./helpers/index.js";

/**
 * Task 11 — prefers-contrast completion.
 *
 * Proves the high-contrast block in `apps/frontend/src/app.css` is no longer
 * focus-ring-only: emulating the preference must produce a MEASURABLE increase
 * in border weight and text contrast, and flip the `--contrast-mode` sentinel.
 *
 * Chromium matches `prefers-contrast: more` (the spec value); the CSS lists both
 * `more` and the legacy `high` keyword, so `emulateMedia({ contrast: 'more' })`
 * activates the block.
 */

interface Probe {
	contrastMode: string;
	borderTopWidth: number;
	mutedColor: string;
	foreground: string;
}

async function probe(page: import("@playwright/test").Page): Promise<Probe> {
	return page.evaluate(() => {
		const root = getComputedStyle(document.documentElement);
		const bordered = document.querySelector("main section.border");
		const muted = document.querySelector("main .text-muted-foreground");
		const px = (v: string): number => Number.parseFloat(v) || 0;
		return {
			contrastMode: root.getPropertyValue("--contrast-mode").trim(),
			borderTopWidth: bordered
				? px(getComputedStyle(bordered).borderTopWidth)
				: -1,
			mutedColor: muted ? getComputedStyle(muted).color : "",
			foreground: root.getPropertyValue("--foreground").trim(),
		};
	});
}

test.describe("prefers-contrast: high completion", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine contrast proof (cage/Chromium parity)",
	);

	test("emulating high contrast thickens borders and boosts text contrast", async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		// Network view renders bordered cards (.border) and muted labels.
		const { navigateTo } = await import("./helpers/index.js");
		await navigateTo(page, "network");
		await expect(page.locator("main section.border").first()).toBeVisible({
			timeout: 15_000,
		});

		await page.emulateMedia({ contrast: "no-preference" });
		const before = await probe(page);

		await page.emulateMedia({ contrast: "more" });
		const after = await probe(page);

		// Restore so later tests in the worker are unaffected.
		await page.emulateMedia({ contrast: "no-preference" });

		const borderIncreased = after.borderTopWidth > before.borderTopWidth;
		const sentinelFlipped =
			before.contrastMode !== "high" && after.contrastMode === "high";
		const textContrastChanged = after.mutedColor !== before.mutedColor;

		const pass = borderIncreased && sentinelFlipped && textContrastChanged;

		fs.writeFileSync(
			evidencePath("task-11-contrast.txt"),
			[
				"Task 11 — prefers-contrast: high completion",
				"",
				"Scenario: measure border weight + muted-text color with the",
				"high-contrast preference off, then emulated on.",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				"prefers-contrast OFF (no-preference):",
				`  --contrast-mode      = ${JSON.stringify(before.contrastMode)} (expect "")`,
				`  card border-top      = ${before.borderTopWidth}px`,
				`  muted text color     = ${before.mutedColor}`,
				"",
				"prefers-contrast ON (more):",
				`  --contrast-mode      = ${JSON.stringify(after.contrastMode)} (expect "high")`,
				`  card border-top      = ${after.borderTopWidth}px (expect > before)`,
				`  muted text color     = ${after.mutedColor} (expect != before, toward foreground)`,
				`  --foreground         = ${after.foreground}`,
				"",
				`border weight increased : ${borderIncreased}`,
				`sentinel flipped to high: ${sentinelFlipped}`,
				`text contrast changed   : ${textContrastChanged}`,
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(sentinelFlipped).toBe(true);
		expect(borderIncreased).toBe(true);
		expect(textContrastChanged).toBe(true);
	});
});
