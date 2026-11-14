import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated } from "./helpers/index.js";

/**
 * The HUD's lifecycle badge paints from the `status-live` / `status-idle`
 * tokens. Those classes only produce CSS when the tokens are registered in the
 * Tailwind `status` palette; without that the LIVE badge has no background and
 * its light label is barely visible in light mode and invisible in dark mode.
 * jsdom cannot evaluate Tailwind, so this checks the computed colour in the
 * real app.
 */

const TRANSPARENT = "rgba(0, 0, 0, 0)";

async function openWithTheme(page: Page, theme: "light" | "dark", streaming: boolean) {
	if (streaming) {
		// The mock never runs a sender, so force the live lifecycle on every
		// status frame the backend pushes.
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				try {
					const frame = JSON.parse(String(m));
					if (frame.status) {
						frame.status.is_streaming = true;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {}
				ws.send(m);
			});
		});
	}
	await page.addInitScript((mode: string) => {
		localStorage.setItem("theme", JSON.stringify(mode));
		localStorage.setItem("mode-watcher-mode", mode);
	}, theme);
	await page.goto("/");
	await ensureAuthenticated(page);
	// Make sure the theme really applied, so the dark cases never quietly
	// rerun light mode.
	const html = page.locator("html");
	if (theme === "dark") await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
	else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
	const lifecycle = page.locator('[data-hud-region] [id$="-lifecycle"]').first();
	await expect(lifecycle).toBeVisible({ timeout: 30000 });
	return lifecycle;
}

for (const theme of ["light", "dark"] as const) {
	test(`the LIVE badge has a background in ${theme} mode`, async ({ page }, info) => {
		test.skip(info.project.name !== "desktop");
		const lifecycle = await openWithTheme(page, theme, true);
		await expect(lifecycle).toHaveClass(/bg-status-live/);
		const background = await lifecycle.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(background, "LIVE badge background").not.toBe(TRANSPARENT);
	});

	test(`the idle dot has a colour in ${theme} mode`, async ({ page }, info) => {
		test.skip(info.project.name !== "desktop");
		const lifecycle = await openWithTheme(page, theme, false);
		const dot = lifecycle.locator(".bg-status-idle");
		await expect(dot).toHaveCount(1);
		const background = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(background, "idle dot background").not.toBe(TRANSPARENT);
	});
}
