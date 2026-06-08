/**
 * Task 13 — responsive multi-resolution hardening.
 *
 * Proves, against the REAL rendered app, the small/portrait touchscreen layouts
 * hardened in this task:
 *
 *   1. 800×480 landscape (the minimum supported landscape resolution): the panel
 *      resolves to DESKTOP CHROME (rail nav, not the mobile bottom dock) and the
 *      ServerDialog renders as a centered Dialog (NOT a bottom Sheet). With a
 *      simulated 250px on-screen-keyboard inset (viewport shrunk to 800×230) the
 *      dialog collapses (`@media (max-height: 500px)`) and the Save action stays
 *      on-screen / reachable. No horizontal overflow throughout.
 *
 *   2. 600×1024 portrait: the panel resolves to the MOBILE layout — bottom-dock
 *      nav + bottom HUD + main content all visible, no clipped controls, no
 *      horizontal overflow.
 *
 * Conventions (PLAYBOOK.md): assert via roles/labels/ARIA + web-first assertions,
 * never screenshots; no fixed-delay waits. Restricted to chromium + the desktop
 * project so the evidence files are written exactly once (the spec drives the
 * viewport itself via setViewportSize, so the project's own viewport is moot).
 */
import fs from 'node:fs';

import { expect, test } from './fixtures/index.js';
import { hudStructure } from './helpers/aria.js';
import { evidencePath, navigateTo } from './helpers/index.js';

test.beforeEach(({ browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-engine layout proof (cage/Chromium parity)');
	test.skip(testInfo.project.name !== 'desktop', 'spec drives its own viewport; run once');
});

/** documentElement is not wider than its viewport (allow 1px sub-pixel rounding). */
async function horizontalOverflowPx(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.documentElement;
		return el.scrollWidth - el.clientWidth;
	});
}

// Containment-in-viewport reader for evidence (1px tolerance). Playwright exposes
// no `locator.isInViewport()`, only the `toBeInViewport()` assertion, so compute
// it from the bounding box.
async function inViewport(
	page: import('@playwright/test').Page,
	locator: import('@playwright/test').Locator,
): Promise<boolean> {
	const box = await locator.boundingBox();
	const vp = page.viewportSize();
	if (!box || !vp) return false;
	return (
		box.x >= -1 &&
		box.y >= -1 &&
		box.x + box.width <= vp.width + 1 &&
		box.y + box.height <= vp.height + 1
	);
}

async function openServerDialog(page: import('@playwright/test').Page) {
	await navigateTo(page, 'live');
	const byTestId = page.getByTestId('open-server-dialog');
	if ((await byTestId.count()) > 0) {
		await byTestId.first().click();
	} else {
		await page.getByRole('button', { name: 'Edit Settings' }).first().click();
	}
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.describe('Task 13 — responsive multi-resolution hardening', () => {
	test('800×480 landscape: desktop chrome, centered Dialog, Save reachable with 250px OSK inset', async ({
		authedPage: page,
	}) => {
		// Minimum supported landscape resolution.
		await page.setViewportSize({ width: 800, height: 480 });

	// Pivot: the 800×480 panel must take DESKTOP CHROME, NOT the mobile dock.
	// (Old lg=1024 pivot would have shown the mobile bottom nav here.)
	await navigateTo(page, 'live');
	const railTab = page.getByTestId('rail-nav').getByRole('button', { name: /live/i });
	const dockTab = page.getByTestId('dock-nav').getByRole('button', { name: /live/i });
	await expect(railTab).toBeVisible();
	await expect(dockTab).toBeHidden();

		const overflowBefore = await horizontalOverflowPx(page);
		expect(overflowBefore).toBeLessThanOrEqual(1);

		// The ServerDialog (largest form) renders as a centered Dialog, not a Sheet.
		const dialog = await openServerDialog(page);
		await expect(page.locator("[data-slot='dialog-content']")).toBeVisible();
		await expect(page.locator("[data-slot='sheet-content']")).toHaveCount(0);

		const overflowDialog = await horizontalOverflowPx(page);
		expect(overflowDialog).toBeLessThanOrEqual(1);

		// Simulate the on-screen keyboard claiming the bottom 250px: the usable
		// area shrinks to 800×230. The `@media (max-height: 500px)` collapse keeps
		// the footer on-screen, so Save stays reachable.
		await page.setViewportSize({ width: 800, height: 230 });

		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeVisible();
		await expect(save).toBeInViewport();

		const overflowOsk = await horizontalOverflowPx(page);
		expect(overflowOsk).toBeLessThanOrEqual(1);

		// The collapsed dialog never exceeds the (reduced) viewport height.
		const dialogContent = page.locator("[data-slot='dialog-content']");
		const box = await dialogContent.boundingBox();
		const fitsHeight = box !== null && box.y >= -1 && box.y + box.height <= 230 + 1;

		const saveInViewport = await inViewport(page, save);
		const pass =
			overflowBefore <= 1 &&
			overflowDialog <= 1 &&
			overflowOsk <= 1 &&
			(await save.isVisible()) &&
			saveInViewport &&
			fitsHeight;

		fs.writeFileSync(
			evidencePath('task-13-800x480.txt'),
			[
				'Task 13 — 800×480 landscape (minimum supported landscape resolution)',
				'',
			'Pivot: short-landscape panel resolves to DESKTOP CHROME (rail nav),',
			'dialogs render as a centered Dialog (not a bottom Sheet).',
			'',
			`  rail-nav "live" button      visible = true (expect: true)`,
			`  dock-nav "live" button      hidden  = true (expect: true)`,
				`  ServerDialog surface        = [data-slot=dialog-content] (expect: Dialog, not Sheet)`,
				'',
				'Horizontal overflow (documentElement.scrollWidth - clientWidth):',
				`  at 800×480 (shell)          = ${overflowBefore}px (expect: ≤1)`,
				`  at 800×480 (dialog open)    = ${overflowDialog}px (expect: ≤1)`,
				`  at 800×230 (OSK inset)      = ${overflowOsk}px (expect: ≤1)`,
				'',
				'On-screen keyboard simulation — viewport shrunk to 800×230 (250px bottom inset):',
				`  Save button visible         = ${await save.isVisible()} (expect: true)`,
				`  Save button in viewport     = ${saveInViewport} (expect: true)`,
				`  dialog fits within 230px    = ${fitsHeight} (expect: true)`,
				box
					? `  dialog box                  = { y: ${Math.round(box.y)}, h: ${Math.round(box.height)} } (bottom ${Math.round(box.y + box.height)} ≤ 230)`
					: '  dialog box                  = (none)',
				'',
				`RESULT: ${pass ? 'PASS' : 'FAIL'}`,
				`generated: ${new Date().toISOString()}`,
				'',
			].join('\n'),
			'utf8',
		);

		expect(pass).toBe(true);
	});

	test('600×1024 portrait: mobile nav + HUD + content visible, no clipped controls', async ({
		authedPage: page,
	}) => {
		// Minimum supported portrait resolution.
		await page.setViewportSize({ width: 600, height: 1024 });

		await navigateTo(page, 'live');

	// Portrait stays on the MOBILE layout: bottom dock nav, not the rail.
	const dockTab = page.getByTestId('dock-nav').getByRole('button', { name: /live/i });
	const railTab = page.getByTestId('rail-nav').getByRole('button', { name: /live/i });
	await expect(dockTab).toBeVisible();
	await expect(railTab).toBeHidden();

	// All three destination tabs present and within the viewport (not clipped).
	const tabNames = ['live', 'network', 'settings'];
	const dockNav = page.getByTestId('dock-nav');
	for (const name of tabNames) {
		const tab = dockNav.getByRole('button', { name: new RegExp(name, 'i') });
		await expect(tab).toBeVisible();
		await expect(tab).toBeInViewport();
	}

		// Persistent HUD (bottom dock) is mounted and visible.
		const hud = await hudStructure(page);
		await expect(hud).toBeInViewport();

		// Main content region renders. MainView's content <main> is the inner one
		// (the PullToRefresh wrapper also renders a <main>), so scope to the last.
		const main = page.getByRole('main').last();
		await expect(main).toBeVisible();

		const overflow = await horizontalOverflowPx(page);
		expect(overflow).toBeLessThanOrEqual(1);

	const tabsInViewport: Record<string, boolean> = {};
	for (const name of tabNames) {
		const tab = dockNav.getByRole('button', { name: new RegExp(name, 'i') });
		tabsInViewport[name] = await inViewport(page, tab);
	}
		const allTabsInViewport = Object.values(tabsInViewport).every(Boolean);
		const hudInViewport = await inViewport(page, hud);

		const pass =
			(await dockTab.isVisible()) &&
			(await railTab.isHidden()) &&
			allTabsInViewport &&
			hudInViewport &&
			(await main.isVisible()) &&
			overflow <= 1;

		fs.writeFileSync(
			evidencePath('task-13-portrait.txt'),
			[
				'Task 13 — 600×1024 portrait (minimum supported portrait resolution)',
				'',
			'Pivot: portrait panel resolves to the MOBILE layout (bottom-dock nav + bottom HUD).',
			'',
			`  dock-nav "live" button      visible = ${await dockTab.isVisible()} (expect: true)`,
			`  rail-nav "live" button      hidden  = ${await railTab.isHidden()} (expect: true)`,
				'',
			'Bottom-dock destination tabs in viewport (no clipped controls):',
			...tabNames.map((name) => `  dock-nav "${name}" button = ${tabsInViewport[name]} (expect: true)`),
				'',
				`  HUD region in viewport      = ${hudInViewport} (expect: true)`,
				`  <main> visible              = ${await main.isVisible()} (expect: true)`,
				`  horizontal overflow         = ${overflow}px (expect: ≤1)`,
				'',
				`RESULT: ${pass ? 'PASS' : 'FAIL'}`,
				`generated: ${new Date().toISOString()}`,
				'',
			].join('\n'),
			'utf8',
		);

		expect(pass).toBe(true);
	});
});
