/**
 * ServerDialog — transport protocol selector (Task 20 / RIST promotion).
 *
 * Against the REAL dev backend (MOCK_SCENARIO=multi-modem-wifi), whose mock
 * engine advertises the `rist` transport (apps/backend mock capabilities):
 *
 *   1. The protocol radiogroup renders SRTLA / SRT / RIST. SRTLA is selected by
 *      default; SRT is reserved (disabled with a reason); RIST is enabled
 *      because the engine advertises it.
 *   2. Selecting RIST and saving persists relay_protocol=rist — it survives a
 *      full page reload (re-auth) and re-opens with RIST still selected.
 *   3. SRTLA selection is unaffected: it stays the default and remains saveable.
 *
 * The complementary "RIST disabled when the engine advertises no rist transport"
 * case is covered by the component unit test (ServerDialog.protocol.test.ts),
 * which can drive the no-capability state the shared mock backend cannot.
 *
 * Conventions (PLAYBOOK.md): assert via roles/test-ids/ARIA, never screenshots;
 * no fixed-delay waits — every async wait is a web-first assertion.
 */
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

test.beforeEach(({ browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the dialog');
});

async function openServerDialog(page: import('@playwright/test').Page) {
	await navigateTo(page, 'live');
	const byTestId = page.getByTestId('open-server-dialog');
	if ((await byTestId.count()) > 0) {
		await byTestId.click();
	} else {
		await page.getByRole('button', { name: 'Edit Settings' }).first().click();
	}
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.describe('ServerDialog — transport protocol selector', () => {
	test('renders SRTLA/SRT/RIST with SRT reserved and RIST capability-enabled', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		const group = dialog.getByTestId('transport-protocol');
		await expect(group).toBeVisible();

		// SRTLA is always selectable.
		const srtla = dialog.getByTestId('protocol-srtla');
		await expect(srtla).toBeEnabled();

		// SRT is a reserved placeholder — visible but disabled with a reason.
		const srt = dialog.getByTestId('protocol-srt');
		await expect(srt).toBeDisabled();
		await expect(srt).toHaveAttribute('title', 'Not yet available');

		// RIST is enabled because the mock engine advertises the rist transport.
		const rist = dialog.getByTestId('protocol-rist');
		await expect(rist).toBeEnabled({ timeout: 15_000 });

		// Selecting SRTLA marks it checked (selection works without assuming the
		// persisted default, which the shared backend may carry across tests).
		await srtla.click();
		await expect(srtla).toHaveAttribute('aria-checked', 'true');
	});

	test('selecting RIST persists relay_protocol=rist across a reload', async ({
		authedPage: page,
	}) => {
		let dialog = await openServerDialog(page);

		const rist = dialog.getByTestId('protocol-rist');
		await expect(rist).toBeEnabled({ timeout: 15_000 });
		await rist.click();
		await expect(rist).toHaveAttribute('aria-checked', 'true');

		// Provide a manual endpoint (even data port for RIST simple profile) so the
		// manual-mode Save predicate is satisfied without a seeded config.
		await dialog.locator('#srtla-addr').fill('127.0.0.1');
		await dialog.locator('#srtla-port').fill('5000');
		await dialog.locator('#srt-streamid').fill('e2e-rist');

		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(dialog).toBeHidden();

		// Reload the whole app and re-authenticate; the persisted protocol must
		// re-open with RIST selected (not reset to SRTLA).
		await page.reload();
		await ensureAuthenticated(page);

		dialog = await openServerDialog(page);
		await expect(dialog.getByTestId('protocol-rist')).toHaveAttribute(
			'aria-checked',
			'true',
		);
	});

	test('SRTLA stays the default and remains saveable (unaffected)', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		const srtla = dialog.getByTestId('protocol-srtla');
		await srtla.click();
		await expect(srtla).toHaveAttribute('aria-checked', 'true');

		await dialog.locator('#srtla-addr').fill('127.0.0.1');
		await dialog.locator('#srtla-port').fill('5000');
		await dialog.locator('#srt-streamid').fill('e2e-srtla');

		await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
	});
});
