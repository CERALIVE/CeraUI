/**
 * Stream Tuning card — receiver-capability gating (Task 16).
 *
 * The Stream Tuning card inside ServerDialog has two top-level states driven by
 * the receiver kind (lib/streaming/receiver-experience):
 *
 *   • CeraLive receiver (managed cloud, remote_provider=ceralive in the dev
 *     backend) → the advanced controls (recovery mode + profile presets) are
 *     ENABLED and the BELABOX banner is absent.
 *   • non-CeraLive (a custom receiver is always unproven) → FEC, recovery, and
 *     the preset chips are DISABLED with a reason tooltip (`title`, never
 *     hidden) and the "Standard (BELABOX-compatible defaults)" banner shows.
 *
 * Conventions (PLAYBOOK.md): assert via roles / test-ids / attributes, never
 * screenshots (the evidence PNG lives in stream-tuning.visual.spec.ts); no
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

	test('non-CeraLive (custom): advanced controls disabled-with-reason + BELABOX banner', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);
		await dialog.getByTestId('destination-custom').click();

		const card = dialog.getByTestId('stream-tuning');
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-receiver-kind', 'non-ceralive');

		// Latency stays available for every receiver.
		await expect(dialog.getByTestId('stream-tuning-latency')).toBeVisible();

		// Advanced controls are disabled WITH a reason tooltip — never hidden.
		const reason = 'Available only with a CeraLive receiver.';
		const fec = dialog.getByTestId('stream-tuning-fec');
		const recovery = dialog.getByTestId('stream-tuning-recovery');
		const classic = dialog.getByTestId('stream-tuning-preset-classic');
		await expect(fec).toBeDisabled();
		await expect(recovery).toBeDisabled();
		await expect(classic).toBeDisabled();
		await expect(fec).toHaveAttribute('title', reason);
		await expect(recovery).toHaveAttribute('title', reason);

		// The BELABOX-compatible banner is shown; CeraLive-only profiles are not.
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toBeVisible();
		await expect(dialog.getByTestId('stream-tuning-preset-balanced')).toHaveCount(0);
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toHaveCount(0);
	});

	test('CeraLive (managed cloud): advanced controls enabled, no banner', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// The dev backend's config carries remote_provider="ceralive", so the
		// managed destination resolves to a CeraLive receiver. Managed enables
		// once the mock relay catalog populates.
		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();
		await expect(managed).toHaveAttribute('aria-checked', 'true');

		const card = dialog.getByTestId('stream-tuning');
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-receiver-kind', 'ceralive');
		await expect(dialog.getByTestId('stream-tuning-ceralive-badge')).toBeVisible();

		// The advanced controls a CeraLive receiver unlocks are interactive.
		await expect(dialog.getByTestId('stream-tuning-recovery')).toBeEnabled();
		await expect(dialog.getByTestId('stream-tuning-preset-classic')).toBeEnabled();

		// No BELABOX-compatible banner in the full-controls state.
		await expect(dialog.getByTestId('stream-tuning-belabox-banner')).toHaveCount(0);
	});
});
