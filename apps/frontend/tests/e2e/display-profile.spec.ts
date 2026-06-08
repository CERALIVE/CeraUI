import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";
import { evidencePath } from "./helpers/index.js";

/**
 * Task 4 (DC-4) — display-profile URL contract (?display=lcd|eink|mono).
 *
 * Proves, against the REAL rendered app, the contract implemented in
 * `apps/frontend/src/App.svelte` + `src/lib/stores/display-profile.svelte.ts`:
 *
 *   - `?display=eink` reflects onto <html> as data-display="eink" AND
 *     data-theme="eink" (the e-ink theme hook authored in Task 10), and the
 *     profile survives an in-SPA reload to a param-less URL (persisted store).
 *   - `?display=bogus` normalizes to the default `lcd`: data-display="lcd",
 *     NO data-theme override, and no console error / uncaught exception.
 *
 * These assertions read attributes on <html>, which App.svelte sets in an
 * $effect at mount — independent of the auth gate — so no login is required.
 * Restricted to the desktop project so the evidence files are written once.
 */

test.describe("display-profile URL contract (DC-4)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine contract proof (cage/Chromium parity)",
	);

	test("?display=eink sets data-display + data-theme and persists across reload", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		const html = page.locator("html");

		// 1. Param applied on load.
		await page.goto("/?display=eink");
		await expect(html).toHaveAttribute("data-display", "eink");
		await expect(html).toHaveAttribute("data-theme", "eink");
		const afterParam = {
			dataDisplay: await html.getAttribute("data-display"),
			dataTheme: await html.getAttribute("data-theme"),
		};

		// 2. Reload to a param-less URL: the persisted store keeps the profile.
		await page.goto("/");
		await expect(html).toHaveAttribute("data-display", "eink");
		await expect(html).toHaveAttribute("data-theme", "eink");
		const afterReload = {
			dataDisplay: await html.getAttribute("data-display"),
			dataTheme: await html.getAttribute("data-theme"),
		};

		const pass =
			afterParam.dataDisplay === "eink" &&
			afterParam.dataTheme === "eink" &&
			afterReload.dataDisplay === "eink" &&
			afterReload.dataTheme === "eink";

		fs.writeFileSync(
			evidencePath("task-4-display-param.txt"),
			[
				"Task 4 (DC-4) — ?display=eink contract",
				"",
				"Scenario: load /?display=eink, then reload to / (no param).",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				"After /?display=eink:",
				`  <html data-display> = ${afterParam.dataDisplay} (expect: eink)`,
				`  <html data-theme>   = ${afterParam.dataTheme} (expect: eink)`,
				"",
				"After reload to / (persisted store, no param):",
				`  <html data-display> = ${afterReload.dataDisplay} (expect: eink)`,
				`  <html data-theme>   = ${afterReload.dataTheme} (expect: eink)`,
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(pass).toBe(true);
	});

	test("?display=bogus falls back to lcd with no console error", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => pageErrors.push(err.message));

		const html = page.locator("html");

		await page.goto("/?display=bogus");
		// Bogus value normalizes to the default profile.
		await expect(html).toHaveAttribute("data-display", "lcd");
		// No e-ink theme override for the lcd profile. mode-watcher owns the
		// data-theme attribute and clears it to "" (not absent) for the default
		// custom theme, so assert the absence of the "eink" override, not null.
		await expect(html).not.toHaveAttribute("data-theme", "eink");
		const dataTheme = await html.getAttribute("data-theme");

		const dataDisplay = await html.getAttribute("data-display");
		const pass =
			dataDisplay === "lcd" &&
			dataTheme !== "eink" &&
			consoleErrors.length === 0 &&
			pageErrors.length === 0;

		fs.writeFileSync(
			evidencePath("task-4-display-fallback.txt"),
			[
				"Task 4 (DC-4) — ?display=bogus fallback",
				"",
				"Scenario: load /?display=bogus (unknown value).",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				`  <html data-display> = ${dataDisplay} (expect: lcd)`,
				`  <html data-theme>   = ${JSON.stringify(dataTheme)} (expect: not "eink"; mode-watcher clears to "")`,
				`  console errors      = ${consoleErrors.length} (expect: 0)`,
				`  uncaught pageerrors = ${pageErrors.length} (expect: 0)`,
				consoleErrors.length > 0
					? `  console error texts: ${JSON.stringify(consoleErrors)}`
					: "",
				pageErrors.length > 0
					? `  pageerror texts: ${JSON.stringify(pageErrors)}`
					: "",
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			]
				.filter((line) => line !== "")
				.join("\n"),
			"utf8",
		);

		expect(dataDisplay).toBe("lcd");
		expect(dataTheme).not.toBe("eink");
		expect(consoleErrors).toEqual([]);
		expect(pageErrors).toEqual([]);
	});
});
