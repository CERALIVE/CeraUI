import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/index.js';
import {
	ensureAuthenticated,
	navigateTo,
	type Destination,
	type ThemeMode,
} from '../helpers/index.js';

/**
 * @gallery — documentation screenshot gallery for the 3-destination layout.
 *
 * This is NOT a visual-regression gate: it uses raw page.screenshot() to write
 * PNGs into apps/frontend/docs/screenshots/ for SCREENSHOTS.md, never
 * toHaveScreenshot(). It is tagged @gallery (never @visual) so the
 * visual-regression entrypoint (test:e2e:visual, `--grep @visual`) never
 * selects it, and it is excluded from every functional entrypoint via
 * `--grep-invert @gallery`. Run it through the dedicated `bun run screenshots`
 * script only. The `.visual.spec.ts` suffix satisfies the CI screenshot
 * guardrail; the fixture screenshot guard permits @gallery alongside @visual.
 *
 * Output (14 PNGs): live/network/settings × dark/light × desktop/mobile (12) +
 * live-streaming × dark/light on desktop (2).
 */

const GALLERY_DIR = path.resolve(import.meta.dirname, '../../../docs/screenshots');
const THEMES = ['dark', 'light'] as const satisfies readonly ThemeMode[];
const DESTINATIONS = ['live', 'network', 'settings'] as const satisfies readonly Destination[];

function shotPath(viewport: string, theme: ThemeMode, name: string): string {
	return path.join(GALLERY_DIR, viewport, theme, `${name}.png`);
}

async function authWithTheme(page: Page, theme: ThemeMode): Promise<void> {
	// Seed the theme before app boot (addInitScript runs ahead of page JS on
	// every navigation) so mode-watcher picks it up on first paint — no reload,
	// no auto-login race from a persisted credential. Then authenticate once.
	await page.addInitScript((mode: string) => {
		localStorage.setItem('theme', JSON.stringify(mode));
		localStorage.setItem('mode-watcher-mode', mode);
	}, theme);
	await page.goto('/');
	await ensureAuthenticated(page);
}

test.describe('@gallery documentation screenshots', () => {
	for (const theme of THEMES) {
		for (const destination of DESTINATIONS) {
			test(
				`@gallery ${destination} ${theme}`,
				{ tag: '@gallery' },
				async ({ page }, testInfo) => {
					await authWithTheme(page, theme);
					await navigateTo(page, destination);
					await expect(page.locator('#main-content')).toBeVisible();
					await page.screenshot({
						path: shotPath(testInfo.project.name, theme, destination),
						fullPage: true,
					});
				},
			);
		}

		test(
			`@gallery live streaming ${theme}`,
			{ tag: '@gallery' },
			async ({ page }, testInfo) => {
				test.skip(
					testInfo.project.name !== 'desktop',
					'streaming gallery is desktop-only (2 shots)',
				);

				// srtla_send never runs under the mock, so the backend reports
				// is_streaming=false. Rewrite every status frame over the page WS to
				// force the streaming cockpit to mount, matching the ingest-states
				// visual harness. Must be installed before the first navigation.
				await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
					const server = ws.connectToServer();
					ws.onMessage((m) => server.send(m));
					server.onMessage((m) => {
						const text = typeof m === 'string' ? m : m.toString();
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

				await authWithTheme(page, theme);
				await navigateTo(page, 'live');
				await expect(page.getByTestId('ingest-stats')).toBeVisible({ timeout: 15_000 });
				await page.screenshot({
					path: shotPath(testInfo.project.name, theme, 'live-streaming'),
					fullPage: true,
				});
			},
		);
	}
});
