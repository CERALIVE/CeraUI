/**
 * Stream Tuning card — latency slider, FEC toggle, recovery mode (Tasks 16-19).
 *
 * The card inside ServerDialog has two top-level states driven by the receiver
 * kind (lib/streaming/receiver-experience):
 *
 *   • CeraLive receiver (managed cloud, remote_provider=ceralive in the dev
 *     backend) → latency slider + FEC switch + the Advanced recovery segmented
 *     control are ENABLED and the BELABOX banner is absent.
 *   • non-CeraLive (a custom receiver is always unproven) → latency stays
 *     adjustable; FEC, recovery, and the preset chips are DISABLED with a reason
 *     tooltip (`title`, never hidden) and the BELABOX-compatible banner shows.
 *
 * Conventions (PLAYBOOK.md): assert via roles / test-ids / attributes, never
 * screenshots (the evidence PNGs live in stream-tuning.visual.spec.ts); no
 * fixed-delay waits — every async wait is a web-first assertion.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

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

test.describe('Stream Tuning card — receiver-capability gating', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser integration proof');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the dialog');
	});

	test('non-CeraLive (custom): latency adjustable; FEC + recovery disabled-with-reason + BELABOX banner', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const card = dialog.getByTestId('stream-tuning');
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-receiver-kind', 'non-ceralive');

		// Latency stays available for every receiver — the slider is enabled.
		const slider = dialog.getByTestId('stream-tuning-latency-slider');
		await expect(slider).toBeVisible();
		await expect(slider).toBeEnabled();
		// non-CeraLive is clamped to the BELABOX-safe 2000 ms ceiling.
		await expect(slider).toHaveAttribute('max', '2000');

		// FEC is disabled WITH a reason tooltip — never hidden.
		const fec = dialog.getByTestId('stream-tuning-fec');
		await expect(fec).toBeDisabled();
		await expect(fec).toHaveAttribute('title', 'Available only with a CeraLive receiver.');

		// Recovery lives behind the Advanced disclosure; expand it and assert the
		// segments are disabled and the group carries the receiver-managed reason.
		await dialog.locator('[data-testid="stream-tuning-advanced"] > summary').click();
		await expect(dialog.getByTestId('stream-tuning-recovery')).toHaveAttribute(
			'title',
			'Receiver-managed.',
		);
		await expect(dialog.getByTestId('stream-tuning-recovery-standard')).toBeDisabled();
		await expect(
			dialog.getByTestId('stream-tuning-recovery-bandwidth-saver'),
		).toBeDisabled();

		// The BELABOX-compatible badge AND banner are shown (a visible state, not
		// just a tooltip); CeraLive-only profiles and the CeraLive badge are not.
		const badge = dialog.getByTestId('stream-tuning-belabox-badge');
		await expect(badge).toBeVisible();
		await expect(badge).toContainText('Standard (BELABOX-compatible)');
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toBeVisible();
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toHaveCount(0);

		// Task 20: preset chips are DISABLED-with-reason, never hidden — Balanced is
		// present (disabled) on a non-CeraLive receiver, not removed.
		const balancedChip = dialog.getByTestId('stream-tuning-preset-balanced');
		await expect(balancedChip).toBeVisible();
		await expect(balancedChip).toBeDisabled();
		await expect(balancedChip).toHaveAttribute(
			'title',
			'Available only with a CeraLive receiver.',
		);
	});

	test('CeraLive (managed cloud): latency slider, FEC switch, and recovery segments enabled', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// The dev backend's config carries remote_provider="ceralive", so the
		// managed destination resolves to a CeraLive receiver.
		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(managed).toHaveAttribute('aria-checked', 'true');

		const card = dialog.getByTestId('stream-tuning');
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-receiver-kind', 'ceralive');
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toBeVisible();

		// Latency slider — continuous, enabled, wide CeraLive window (5000 ms).
		const slider = dialog.getByTestId('stream-tuning-latency-slider');
		await expect(slider).toBeEnabled();
		await expect(slider).toHaveAttribute('max', '5000');
		await slider.fill('2500');
		await expect(dialog.getByTestId('stream-tuning-latency-value')).toContainText('2.5 s');

		// FEC gating: this dev capability snapshot doesn't advertise fec_capable, so
		// even a CeraLive receiver shows FEC disabled — but with the DISTINCT
		// "build doesn't support FEC" reason, not the non-CeraLive one. (The
		// FEC-enabled interactive path is covered by the unit tests.)
		const fec = dialog.getByTestId('stream-tuning-fec');
		await expect(fec).toBeDisabled();
		await expect(fec).toHaveAttribute(
			'title',
			"This CeraLive receiver's libsrt build doesn't support FEC.",
		);

		// Recovery segmented control — both segments interactive and the selection
		// toggles. (The default-Standard seed is covered by the unit tests; here we
		// click-to-set so the assertion is independent of any persisted config.)
		await dialog.locator('[data-testid="stream-tuning-advanced"] > summary').click();
		const standard = dialog.getByTestId('stream-tuning-recovery-standard');
		const saver = dialog.getByTestId('stream-tuning-recovery-bandwidth-saver');
		await expect(standard).toBeEnabled();
		await expect(saver).toBeEnabled();
		await standard.click();
		await expect(standard).toHaveAttribute('aria-pressed', 'true');
		await expect(saver).toHaveAttribute('aria-pressed', 'false');
		await saver.click();
		await expect(saver).toHaveAttribute('aria-pressed', 'true');
		await expect(standard).toHaveAttribute('aria-pressed', 'false');

		// No BELABOX-compatible banner in the full-controls state.
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toHaveCount(0);
	});

	test('preset snap-chips: Classic applies its combination; unavailable presets disabled-with-reason; editing flips to Custom', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(dialog.getByTestId('stream-tuning')).toHaveAttribute(
			'data-receiver-kind',
			'ceralive',
		);

		// The dev capability snapshot advertises only Classic and no FEC, so the
		// other chips render DISABLED-with-reason (never hidden): the FEC preset
		// carries the FEC reason, an unadvertised profile carries its own reason.
		const fecPreset = dialog.getByTestId('stream-tuning-preset-low-latency-fec');
		await expect(fecPreset).toBeDisabled();
		await expect(fecPreset).toHaveAttribute(
			'title',
			"This CeraLive receiver's libsrt build doesn't support FEC.",
		);
		const balanced = dialog.getByTestId('stream-tuning-preset-balanced');
		await expect(balanced).toBeDisabled();
		await expect(balanced).toHaveAttribute(
			'title',
			"This receiver doesn't offer this profile.",
		);

		// Classic is the one advertised preset — clicking it snaps the full
		// combination (~2 s latency + Bandwidth Saver recovery) and marks it active.
		const value = dialog.getByTestId('stream-tuning-latency-value');
		const classic = dialog.getByTestId('stream-tuning-preset-classic');
		const custom = dialog.getByTestId('stream-tuning-preset-custom');
		await expect(classic).toBeEnabled();
		await classic.click();
		await expect(value).toContainText('2 s');
		await expect(classic).toHaveAttribute('aria-pressed', 'true');

		// Editing the slider off every preset flips the active chip to Custom.
		await dialog.getByTestId('stream-tuning-latency-slider').fill('1250');
		await expect(custom).toHaveAttribute('aria-pressed', 'true');
		await expect(classic).toHaveAttribute('aria-pressed', 'false');
	});

	test('latency slider is keyboard-navigable (arrow keys change the value)', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const slider = dialog.getByTestId('stream-tuning-latency-slider');
		// Stage a mid-range value so an arrow step never clamps at a bound.
		await slider.fill('500');
		await expect(slider).toHaveAttribute('aria-valuenow', '500');

		await slider.focus();
		await slider.press('ArrowRight');
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
			.toBeGreaterThan(500);

		const afterRight = Number(await slider.getAttribute('aria-valuenow'));
		await slider.press('ArrowLeft');
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
			.toBeLessThan(afterRight);

		// The slider carries a human-readable value text, not just the raw number.
		await expect(slider).toHaveAttribute('aria-valuetext', /\d\s?s/);
		await expect(slider).toHaveAttribute('aria-label', 'Latency');
	});

	test('non-CeraLive card has zero critical axe violations', async ({ authedPage: page }) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();
		await expect(dialog.getByTestId('stream-tuning')).toBeVisible();
		// Expand the Advanced disclosure so axe also audits the recovery controls.
		await dialog.locator('[data-testid="stream-tuning-advanced"] > summary').click();
		await expect(dialog.getByTestId('stream-tuning-recovery')).toBeVisible();

		const results = await new AxeBuilder({ page })
			.include('[data-testid="stream-tuning"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const critical = results.violations.filter((v) => v.impact === 'critical');
		expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
	});

	test('card has no horizontal overflow at phone / tablet / desktop widths', async ({
		authedPage: page,
	}) => {
		for (const width of [375, 768, 1280]) {
			await test.step(`viewport ${width}px`, async () => {
				await page.setViewportSize({ width, height: 800 });
				const dialog = await openServerDialog(page);
				await dialog.getByTestId('destination-custom').click();

				const card = dialog.getByTestId('stream-tuning');
				await expect(card).toBeVisible();
				await expect(dialog.getByTestId('stream-tuning-latency-slider')).toBeVisible();
				await expect(dialog.getByTestId('stream-tuning-belabox-badge')).toBeVisible();

				const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
				expect(overflow, `card overflows at ${width}px`).toBeLessThanOrEqual(1);

				await page.keyboard.press('Escape');
				await expect(card).toHaveCount(0);
			});
		}
	});

	test('prefers-reduced-motion collapses the card transitions', async ({ authedPage: page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const duration = await dialog
			.getByTestId('stream-tuning-fec')
			.evaluate((el) => getComputedStyle(el).transitionDuration);
		expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
	});
});
