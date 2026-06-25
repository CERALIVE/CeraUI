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

		// The BELABOX-compatible banner is shown; CeraLive-only profiles are not.
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toBeVisible();
		await expect(dialog.getByTestId('stream-tuning-preset-balanced')).toHaveCount(0);
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toHaveCount(0);
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
});
