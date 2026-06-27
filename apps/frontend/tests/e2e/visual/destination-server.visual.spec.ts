/**
 * @visual evidence for the destination-first ServerDialog (Task 15).
 *
 * One PNG per state so a reviewer can eyeball the receiver-experience overhaul
 * without running the app:
 *   1. destination chooser      4. RIST selected
 *   2. managed configured       5. plain-SRT coming-soon
 *   3. custom SRTLA             6. kind-aware Live summary (header chip)
 *
 * Captured at THREE viewport contexts and one RTL locale:
 *   • DESKTOP        1280×800
 *   • MOBILE-Sheet   390×844 (where AppDialog renders the bottom Sheet)
 *   • KIOSK touch    1024×600 with ?mode=touch (44px-scaled targets)
 *   • RTL            Arabic locale capture of the dialog
 *
 * Unlike the existing @visual specs (which skip every non-desktop project via
 * `test.skip(testInfo.project.name !== "desktop")`), these captures must run at
 * the added viewports — so this file drives the viewport/locale/mode itself
 * within the single desktop project run (mirrors responsive-touch.spec.ts) rather
 * than relying on a second Playwright project. PNGs land in
 * apps/frontend/test-results/task-15-visual/ (repo-local, gitignored). Tagged
 * @visual so the screenshot guard in fixtures permits the captures here.
 */
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, EVIDENCE_DIR, navigateTo, setLocale } from '../helpers/index.js';

const VISUAL_DIR = path.join(EVIDENCE_DIR, 'task-15-visual');

async function openServerDialog(page: Page) {
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

/**
 * Walk the dialog through all six states for one viewport context, writing a PNG
 * per state. `prefix` namespaces the files (e.g. "desktop", "mobile", "kiosk").
 */
async function captureStates(page: Page, prefix: string): Promise<void> {
	const shot = (name: string, locator: ReturnType<Page['locator']>) =>
		locator.screenshot({ path: path.join(VISUAL_DIR, `${prefix}-${name}.png`) });

	const dialog = await openServerDialog(page);

	// 1. Destination chooser — the dialog leads with the destination radiogroup.
	await expect(dialog.getByTestId('destination')).toBeVisible();
	await shot('1-chooser', dialog);

	// 3. Custom SRTLA — the custom receiver form (srtla is the default kind). The
	// transport-protocol radiogroup is promoted above it (T21), so this frame also
	// captures the always-visible selector.
	await dialog.getByTestId('destination-custom').click();
	await dialog.locator('#srtla-addr').fill('10.20.30.40');
	await dialog.locator('#srtla-port').fill('7777');
	await shot('3-custom-srtla', dialog);

	// 4 + 5. Transport-protocol radiogroup (always visible) — RIST selected, plus
	// the plain-SRT ComingSoon cell.
	const rist = dialog.getByTestId('protocol-rist');
	await expect(rist).toBeEnabled({ timeout: 15_000 });
	await rist.click();
	await expect(rist).toHaveAttribute('aria-checked', 'true');
	await shot('4-rist-selected', dialog);
	await shot('5-plain-srt-coming-soon', dialog.getByTestId('protocol-srt'));

	// 2. Managed configured — pick the cloud account + a seeded server.
	const managed = dialog.getByTestId('destination-managed');
	await expect(managed).toBeEnabled({ timeout: 15_000 });
	await managed.click();
	await dialog.locator('#relay-server').click();
	await page.getByRole('option').first().click();
	await expect(dialog.locator('#relay-server [data-rtt-tier]')).toBeVisible();
	await shot('2-managed-configured', dialog);

	// 6. Kind-aware Live summary — save, then capture the Live header chip. The
	// chip reflects the shared backend config, so this is an evidence capture
	// only (no strict attribute assertion that sibling specs could race).
	const save = dialog.getByRole('button', { name: 'Save' });
	await expect(save).toBeEnabled();
	await save.click();
	await expect(dialog).toBeHidden();
	const chip = page.getByTestId('live-server-chip');
	await expect(chip).toBeVisible();
	await shot('6-live-summary', chip);
}

test.describe('@visual destination-first ServerDialog', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-engine visual evidence');
		// This file drives its own viewport/locale, so it runs ONCE (desktop
		// project) and captures every context itself — it must NOT inherit the
		// desktop-only skip the other @visual specs use to drop mobile.
		test.skip(testInfo.project.name !== 'desktop', 'spec drives its own viewport; run once');
	});

	test('desktop 1280×800 — six states', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await captureStates(page, 'desktop');
	});

	test('mobile Sheet 390×844 — six states', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await captureStates(page, 'mobile');
	});

	test('kiosk 1024×600 ?mode=touch — six states', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 600 });
		await page.goto('/?mode=touch');
		await ensureAuthenticated(page);
		await captureStates(page, 'kiosk');
	});

	test('RTL (Arabic) — destination chooser dialog', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await setLocale(page, 'ar');
		await page.reload();
		await ensureAuthenticated(page);
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

		// Locale-agnostic open: in Arabic the dialog's accessible name is the
		// translated title, so open via the testid trigger and locate the dialog
		// by role (the only open dialog) + the locale-independent destination testid.
		await navigateTo(page, 'live');
		const trigger = page.getByTestId('open-server-dialog');
		if ((await trigger.count()) > 0) {
			await trigger.first().click();
		} else {
			await page.getByTestId('live-server-chip').click();
		}
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByTestId('destination')).toBeVisible();
		await dialog.screenshot({ path: path.join(VISUAL_DIR, 'rtl-chooser.png') });
	});
});
