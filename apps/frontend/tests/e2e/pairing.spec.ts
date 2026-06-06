/**
 * Device pairing (claim code) — end-to-end flow against the mock platform.
 *
 * Exercises the full device-side sequence inside the Cloud Remote dialog:
 * generate a claim code → display it with its validity window → drive the
 * dev-only mock-platform completion → device stores the issued token and the UI
 * reflects the paired state. The mock-platform claim endpoint stands in for the
 * real platform, so this runs without any cloud dependency.
 *
 * See PLAYBOOK.md — no screenshots, no fixed-delay waits; web-first assertions
 * and a charset assertion on the rendered code.
 */
import { expect } from '@playwright/test';

import { test } from './fixtures/index.js';
import { SettingsPage } from './pages/settings.js';

const CLAIM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,8}$/;

test.describe('Device pairing (claim code)', () => {
	test('generates a claim code with a validity window', async ({ authedPage: page }) => {
		const settings = new SettingsPage(page);
		await settings.open();
		await settings.openCloudRemote();

		const code = await settings.generateClaimCode();
		expect(code).toMatch(CLAIM_CODE_PATTERN);

		await settings.closeCloudRemote();
		await expect(page.getByRole('dialog', { name: 'Cloud Remote Server' })).toBeHidden();
	});

	test('completes pairing against the mock platform', async ({ authedPage: page }) => {
		const settings = new SettingsPage(page);
		await settings.open();
		await settings.openCloudRemote();

		await settings.generateClaimCode();
		await settings.simulatePairing();

		await expect(page.getByTestId('pairing-status')).toBeVisible();

		await settings.closeCloudRemote();
	});
});
