import fs from 'node:fs';

import { expect, test } from './fixtures/index.js';
import { evidencePath } from './helpers/index.js';
import { NetworkPage } from './pages/network.js';

/**
 * Task 21 — password-reveal toggle + hotspot credential copy.
 *
 * Proves, against the REAL rendered app, the behaviour implemented in
 * `apps/frontend/src/main/dialogs/HotspotDialog.svelte`:
 *
 *   - The hotspot password field defaults to type="password" (hidden) and the
 *     eye toggle flips it to type="text" and back, updating its aria-label.
 *   - The SSID (name) and password copy buttons write the current field value
 *     to the clipboard and surface a confirmation toast.
 *
 * Scoped to the desktop/chromium project so the evidence files are written once.
 * Clipboard reads require an explicit permission grant on the browser context.
 */

const HOTSPOT_DIALOG = 'Configure Hotspot';
// Deterministic credentials typed into the form — independent of the mock's
// live hotspot state, so the copy assertion never depends on broadcast timing.
const TEST_SSID = 'CeraLive-E2E';
const TEST_PASSWORD = 'e2epass123';

test.describe('Hotspot credentials — reveal toggle + copy', () => {
	test('password reveal toggle: default hidden, flips to text and back', async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'run once, on desktop');

		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();

		const dialog = page.getByRole('dialog', { name: HOTSPOT_DIALOG });
		const passwordInput = dialog.locator('#hotspot-password');

		// 1. Default state: the password is masked.
		await expect(passwordInput).toHaveAttribute('type', 'password');
		const defaultType = await passwordInput.getAttribute('type');

		// 2. Reveal — the toggle exposes "Show password" while hidden.
		const showToggle = dialog.getByRole('button', { name: 'Show password' });
		await expect(showToggle).toBeVisible();
		await showToggle.click();
		await expect(passwordInput).toHaveAttribute('type', 'text');
		const revealedType = await passwordInput.getAttribute('type');

		// 3. Hide again — the aria-label has flipped to "Hide password".
		const hideToggle = dialog.getByRole('button', { name: 'Hide password' });
		await expect(hideToggle).toBeVisible();
		await hideToggle.click();
		await expect(passwordInput).toHaveAttribute('type', 'password');
		const hiddenAgainType = await passwordInput.getAttribute('type');

		const pass =
			defaultType === 'password' &&
			revealedType === 'text' &&
			hiddenAgainType === 'password';

		fs.writeFileSync(
			evidencePath('task-21-reveal.txt'),
			[
				'Task 21 — hotspot password reveal toggle',
				'',
				'Scenario: open Configure Hotspot, toggle the password eye control.',
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				'',
				`  default field type       = ${defaultType} (expect: password)`,
				'  toggle aria-label hidden = "Show password"',
				`  after Show click type    = ${revealedType} (expect: text)`,
				'  toggle aria-label shown  = "Hide password"',
				`  after Hide click type    = ${hiddenAgainType} (expect: password)`,
				'',
				`RESULT: ${pass ? 'PASS' : 'FAIL'}`,
				`generated: ${new Date().toISOString()}`,
				'',
			].join('\n'),
			'utf8',
		);

		expect(pass).toBe(true);
	});

	test('copy SSID + password populates clipboard with confirmation', async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'run once, on desktop');

		// Clipboard read/write must be explicitly granted to the context.
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();

		const dialog = page.getByRole('dialog', { name: HOTSPOT_DIALOG });

		// Type deterministic credentials so the copy targets known values.
		const nameInput = dialog.locator('#hotspot-name');
		const passwordInput = dialog.locator('#hotspot-password');
		await nameInput.fill(TEST_SSID);
		await passwordInput.fill(TEST_PASSWORD);

		// ── Copy SSID ──
		await dialog.getByRole('button', { name: 'Copy network name' }).click();
		await expect(page.getByText('Network name copied')).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
				message: 'clipboard should hold the SSID',
			})
			.toBe(TEST_SSID);
		const clipboardAfterName = await page.evaluate(() =>
			navigator.clipboard.readText(),
		);

		// ── Copy password ──
		await dialog.getByRole('button', { name: 'Copy password' }).click();
		await expect(page.getByText('Password copied')).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
				message: 'clipboard should hold the password',
			})
			.toBe(TEST_PASSWORD);
		const clipboardAfterPassword = await page.evaluate(() =>
			navigator.clipboard.readText(),
		);

		const pass =
			clipboardAfterName === TEST_SSID && clipboardAfterPassword === TEST_PASSWORD;

		fs.writeFileSync(
			evidencePath('task-21-copy.txt'),
			[
				'Task 21 — hotspot SSID + password copy-to-clipboard',
				'',
				'Scenario: open Configure Hotspot, type creds, click the copy buttons.',
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				'',
				`  typed SSID               = ${TEST_SSID}`,
				`  clipboard after copy SSID= ${clipboardAfterName} (expect: ${TEST_SSID})`,
				'  confirmation toast       = "Network name copied"',
				'',
				`  typed password           = (${TEST_PASSWORD.length} chars, not shown in source elsewhere)`,
				`  clipboard after copy pwd = ${clipboardAfterPassword === TEST_PASSWORD ? 'MATCH' : 'MISMATCH'} (expect: MATCH)`,
				'  confirmation toast       = "Password copied"',
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
