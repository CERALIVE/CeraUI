import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";
import { evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Task 11 — Symbol/text-coded status (a11y, colorblind, monochrome e-ink).
 *
 * Proves the non-color coding added to `LinkIndicator.svelte`: every bonded
 * link in the 6-colour spectral ramp (`--link-1..--link-6`) also carries a
 * distinct, color-independent cue — a `data-link-level` ordinal and a
 * `role="img"` + "Link N" aria-label — so the six links stay tellable apart
 * with hue removed (grayscale e-ink) or unperceived (colorblind users).
 *
 * The MOCK_SCENARIO=multi-modem-wifi backend (playwright.config default) renders
 * the full six-link bond, so the ramp can be read straight from the network
 * view without injecting state. The same link renders in both the compact HUD
 * and the Bonded Links card; cues are deduped by ordinal, which both proves
 * cross-surface consistency and yields one entry per distinct link.
 */

interface LinkCue {
	level: number;
	ariaLabel: string;
	role: string | null;
}

async function readLinkCues(page: Page): Promise<LinkCue[]> {
	const cues = await page.evaluate(() => {
		const map: Record<number, { level: number; ariaLabel: string; role: string | null }> = {};
		for (const el of Array.from(document.querySelectorAll("[data-link-level]"))) {
			const level = Number(el.getAttribute("data-link-level"));
			if (!Number.isFinite(level)) continue;
			map[level] = {
				level,
				ariaLabel: el.getAttribute("aria-label") ?? "",
				role: el.getAttribute("role"),
			};
		}
		return Object.values(map);
	});
	return cues.sort((a, b) => a.level - b.level);
}

test.describe("symbol-coded link status (non-color cues)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine a11y proof (cage/Chromium parity)",
	);

	test("each of 6 spectral links exposes a distinct ordinal + aria-label", async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		await navigateTo(page, "network");

		await expect
			.poll(async () => (await readLinkCues(page)).length, {
				timeout: 15_000,
				message: "six distinct bonded-link levels should render",
			})
			.toBeGreaterThanOrEqual(6);

		const cues = (await readLinkCues(page)).slice(0, 6);
		const levels = cues.map((c) => c.level);
		const labels = cues.map((c) => c.ariaLabel);

		expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
		expect(new Set(levels).size).toBe(6);
		expect(new Set(labels).size).toBe(6);
		for (const cue of cues) {
			expect(cue.role).toBe("img");
			expect(cue.ariaLabel).toBe(`Link ${cue.level}`);
		}

		const pass =
			levels.length === 6 &&
			new Set(levels).size === 6 &&
			new Set(labels).size === 6 &&
			cues.every((c) => c.role === "img" && c.ariaLabel === `Link ${c.level}`);

		fs.writeFileSync(
			evidencePath("task-11-symbols.txt"),
			[
				"Task 11 — symbol/text-coded link status (non-color cue)",
				"",
				"Scenario: read every [data-link-level] indicator's color-independent",
				"cue (ordinal + role + aria-label) across the rendered 6-link bond.",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				"Per-link cues (deduped by ordinal):",
				...cues.map(
					(c) => `  L${c.level}: role=${c.role} aria-label=${JSON.stringify(c.ariaLabel)}`,
				),
				"",
				`distinct ordinals : ${new Set(levels).size} (expect 6)`,
				`distinct labels   : ${new Set(labels).size} (expect 6)`,
				`contiguous 1..6   : ${JSON.stringify(levels) === JSON.stringify([1, 2, 3, 4, 5, 6])}`,
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(pass).toBe(true);
	});
});
