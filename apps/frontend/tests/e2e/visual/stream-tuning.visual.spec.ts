/**
 * @visual evidence for the Stream Tuning card (Task 16).
 *
 * Captures the card in both receiver states so a reviewer can eyeball the
 * capability gating without running the app:
 *   • non-ceralive (custom) — advanced controls disabled-with-reason + the
 *     BELABOX-compatible banner. This is the primary task-16 evidence PNG.
 *   • ceralive (managed)    — full controls + the CeraLive receiver badge.
 *
 * PNGs land in apps/frontend/test-results/task-16-visual/ (repo-local,
 * gitignored). Tagged @visual so the screenshot guard in fixtures permits the
 * captures here.
 */
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, EVIDENCE_DIR, navigateTo } from '../helpers/index.js';

const VISUAL_DIR = path.join(EVIDENCE_DIR, 'task-16-visual');
const TASK23_DIR = path.join(EVIDENCE_DIR, 'task-23-srt-receive-profiles');

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

test.describe('@visual Stream Tuning card', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-engine visual evidence');
		test.skip(testInfo.project.name !== 'desktop', 'spec drives its own viewport; run once');
	});

	test('stream-tuning card — both receiver states', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);

		const dialog = await openServerDialog(page);

		// non-CeraLive: custom receiver → disabled-with-reason + BELABOX banner.
		await dialog.getByTestId('destination-custom').click();
		const card = dialog.getByTestId('stream-tuning');
		await expect(card).toHaveAttribute('data-receiver-kind', 'non-ceralive');
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toBeVisible();
		await card.screenshot({ path: path.join(VISUAL_DIR, 'non-ceralive.png') });
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-16-srt-receive-profiles.png'),
		});
		// Task 20 evidence — preset snap-chips disabled-with-reason (never hidden).
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-20-non-ceralive.png'),
		});

		// CeraLive: managed cloud → full controls + receiver badge.
		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(card).toHaveAttribute('data-receiver-kind', 'ceralive');
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toBeVisible();
		await card.screenshot({ path: path.join(VISUAL_DIR, 'ceralive.png') });
		// Task 20 evidence — the preset snap-chip row on a CeraLive receiver. The
		// dev caps advertise only Classic, so the other chips show disabled-with-
		// reason (never hidden) — the row is the evidence, no click needed.
		await expect(dialog.getByTestId('stream-tuning-presets')).toBeVisible();
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-20-srt-receive-profiles.png'),
		});

		// Task 17 evidence — the continuous latency slider + live value pill.
		await dialog.getByTestId('stream-tuning-latency-slider').fill('1500');
		await expect(dialog.getByTestId('stream-tuning-latency-value')).toContainText('1.5 s');
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-17-srt-receive-profiles.png'),
		});

		// Task 18 evidence — the FEC switch + helper text on a CeraLive receiver.
		await expect(dialog.getByTestId('stream-tuning-fec')).toBeVisible();
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-18-srt-receive-profiles.png'),
		});

		// Task 19 evidence — the Advanced recovery segmented control, expanded.
		await dialog.locator('[data-testid="stream-tuning-advanced"] > summary').click();
		await expect(dialog.getByTestId('stream-tuning-recovery-standard')).toBeVisible();
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-19-srt-receive-profiles.png'),
		});

		// Task 21 evidence — the plain-language summary line + the drift note after
		// an edit diverges the selection from the device-active profile.
		await dialog.getByTestId('destination-custom').click();
		await dialog.getByTestId('stream-tuning-latency-slider').fill('1500');
		await expect(dialog.getByTestId('stream-tuning-summary')).toContainText('1.5 s delay');
		await expect(dialog.getByTestId('stream-tuning-drift')).toBeVisible();
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-21-summary-drift.png'),
		});
	});

	test('task-23 — every receiver-capability state', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);

		const dialog = await openServerDialog(page);
		const card = dialog.getByTestId('stream-tuning');

		await dialog.getByTestId('destination-custom').click();
		await expect(card).toHaveAttribute('data-receiver-kind', 'non-ceralive');
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toBeVisible();
		await card.screenshot({ path: path.join(TASK23_DIR, 'non-ceralive.png') });

		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(card).toHaveAttribute('data-receiver-kind', 'ceralive');
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toBeVisible();
		await card.screenshot({ path: path.join(TASK23_DIR, 'ceralive-full-controls.png') });

		await dialog.getByTestId('stream-tuning-preset-classic').click();
		await expect(dialog.getByTestId('stream-tuning-latency-value')).toContainText('2 s');
		await card.screenshot({ path: path.join(TASK23_DIR, 'preset-classic-active.png') });

		await dialog.getByTestId('stream-tuning-latency-slider').fill('1350');
		await expect(dialog.getByTestId('stream-tuning-preset-custom')).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await card.screenshot({ path: path.join(TASK23_DIR, 'custom-chip-active.png') });

		await dialog.locator('[data-testid="stream-tuning-advanced"] > summary').click();
		await expect(dialog.getByTestId('stream-tuning-recovery-standard')).toBeVisible();
		await card.screenshot({ path: path.join(TASK23_DIR, 'recovery-advanced-expanded.png') });

		await dialog.getByTestId('destination-custom').click();
		await dialog.getByTestId('stream-tuning-latency-slider').fill('1500');
		await expect(dialog.getByTestId('stream-tuning-summary')).toContainText('1.5 s delay');
		await expect(dialog.getByTestId('stream-tuning-drift')).toBeVisible();
		await card.screenshot({ path: path.join(TASK23_DIR, 'summary-and-drift.png') });
	});

	test('task-23 — cloud-override affordance', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		await page.evaluate(() => {
			(window as Window & { __ceraProfileDecidedBy?: string }).__ceraProfileDecidedBy =
				'operator';
		});

		const byTestId = page.getByTestId('open-server-dialog');
		if ((await byTestId.count()) > 0) {
			await byTestId.first().click();
		} else {
			await page.getByRole('button', { name: 'Edit Settings' }).first().click();
		}
		const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
		await expect(dialog).toBeVisible();
		await dialog.getByTestId('destination-custom').click();

		const card = dialog.getByTestId('stream-tuning');
		await expect(dialog.getByTestId('stream-tuning-cloud-override')).toBeVisible();
		await card.screenshot({ path: path.join(TASK23_DIR, 'cloud-override.png') });
	});

	test('task-23 — responsive widths', { tag: '@visual' }, async ({ page }) => {
		await page.goto('/');
		await ensureAuthenticated(page);

		for (const width of [375, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			const dialog = await openServerDialog(page);
			await dialog.getByTestId('destination-custom').click();
			const card = dialog.getByTestId('stream-tuning');
			await expect(card).toBeVisible();
			await card.screenshot({ path: path.join(TASK23_DIR, `responsive-${width}.png`) });
			await page.keyboard.press('Escape');
			await expect(card).toHaveCount(0);
		}
	});

	test('stream-tuning card — cloud override affordance', { tag: '@visual' }, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		await page.evaluate(() => {
			(window as Window & { __ceraProfileDecidedBy?: string }).__ceraProfileDecidedBy =
				'operator';
		});

		const byTestId = page.getByTestId('open-server-dialog');
		if ((await byTestId.count()) > 0) {
			await byTestId.first().click();
		} else {
			await page.getByRole('button', { name: 'Edit Settings' }).first().click();
		}
		const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
		await expect(dialog).toBeVisible();
		await dialog.getByTestId('destination-custom').click();

		const card = dialog.getByTestId('stream-tuning');
		await expect(dialog.getByTestId('stream-tuning-cloud-override')).toBeVisible();
		await card.screenshot({
			path: path.join(VISUAL_DIR, 'task-21-srt-receive-profiles.png'),
		});
	});
});
