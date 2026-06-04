/**
 * ServerDialog — method-based UI (Task 16).
 *
 * Covers the four behaviours Task 16 adds on top of the existing manual/relay
 * toggle, against the REAL dev backend (MOCK_SCENARIO=multi-modem-wifi):
 *
 *   1. Method switch — Manual Configuration ↔ Relay Server tabs.
 *   2. Relay method — provider selector, a selected server's auto-preloaded
 *      endpoint shown READ-ONLY, and the manual-override toggle revealing
 *      editable host/port.
 *   3. Manual custom-relay validation — a reachable endpoint passes
 *      (`relay.validate` → { valid: true, stage: "probe" }). A local UDP echo
 *      responder answers the backend's post-connection reachability probe.
 *   4. Manual custom-relay validation — an unresolvable host fails at the `dns`
 *      stage and the inline reason is surfaced.
 *
 * Conventions (PLAYBOOK.md): assert via roles/labels/ARIA, never screenshots;
 * no fixed-delay waits — every async wait is a web-first assertion. The relay
 * catalog populates from the mock backend a short while after auth, so relay
 * scenarios gate on the relay tab becoming enabled.
 */
import { createSocket } from 'node:dgram';

import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

test.beforeEach(({ browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the relay dialog');
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

test.describe('ServerDialog — method-based UI', () => {
	test('switches between Manual Configuration and Relay Server methods', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		const manualTab = dialog.getByRole('tab', { name: 'Manual Configuration' });
		const relayTab = dialog.getByRole('tab', { name: 'Relay Server' });

		// Manual is the default method with no saved relay server.
		await expect(manualTab).toHaveAttribute('aria-selected', 'true');
		await expect(dialog.locator('#srtla-addr')).toBeVisible();

		// The relay tab enables once the mock catalog arrives, then drives the body.
		await expect(relayTab).toBeEnabled({ timeout: 15_000 });
		await relayTab.click();
		await expect(relayTab).toHaveAttribute('aria-selected', 'true');
		await expect(dialog.locator('#relay-server')).toBeVisible();

		await manualTab.click();
		await expect(manualTab).toHaveAttribute('aria-selected', 'true');
		await expect(dialog.locator('#srtla-addr')).toBeVisible();
	});

	test('relay method shows provider, auto-preloaded endpoint (read-only) and manual override', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		const relayTab = dialog.getByRole('tab', { name: 'Relay Server' });
		await expect(relayTab).toBeEnabled({ timeout: 15_000 });
		await relayTab.click();

		// Provider selector is present (managed-provider grouping).
		await expect(dialog.locator('#relay-provider')).toBeVisible();

		// Select the first catalog server, exercising the real Select UI.
		await dialog.locator('#relay-server').click();
		await page.getByRole('option').first().click();

		// The auto-preloaded endpoint renders READ-ONLY (an <output>, not editable),
		// and is not the empty placeholder once a server is selected.
		const endpoint = dialog.locator('#relay-endpoint');
		await expect(endpoint).toBeVisible();
		await expect(endpoint).not.toHaveText('—');

		// Editable Stream ID is present (auto-fill target from relay_streamid_override).
		await expect(dialog.locator('#relay-streamid')).toBeVisible();

		// Manual override reveals editable host/port; the read-only endpoint hides.
		const override = dialog.getByRole('switch', { name: 'Manual override' });
		await expect(override).toHaveAttribute('aria-checked', 'false');
		await override.click();
		await expect(override).toHaveAttribute('aria-checked', 'true');
		await expect(dialog.locator('#relay-override-addr')).toBeVisible();
		await expect(dialog.locator('#relay-override-port')).toBeVisible();
		await expect(dialog.locator('#relay-endpoint')).toHaveCount(0);
	});

	test('manual custom-relay validation — reachable endpoint passes', async ({
		authedPage: page,
	}) => {
		// Loopback UDP echo answers the backend `probe` stage on an ephemeral port.
		const echo = createSocket('udp4');
		const port = await new Promise<number>((resolve) => {
			echo.on('message', (msg, rinfo) => echo.send(msg, rinfo.port, rinfo.address));
			echo.bind(0, '127.0.0.1', () => resolve(echo.address().port));
		});

		try {
			const dialog = await openServerDialog(page);

			await dialog.locator('#srtla-addr').fill('127.0.0.1');
			await dialog.locator('#srtla-port').fill(String(port));
			await dialog.locator('#srt-streamid').fill('e2e-stream');

			await dialog.locator('#relay-validate').click();
			await expect(dialog.getByText('Endpoint reachable')).toBeVisible({ timeout: 15_000 });

			// A passing validation keeps Save enabled.
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
		} finally {
			echo.close();
		}
	});

	test('manual custom-relay validation — unresolvable host fails at dns stage', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// `.invalid` is RFC-2606 reserved: it never resolves, so DNS is the first
		// failing stage (address/port/protocol/endpoint all pass).
		await dialog.locator('#srtla-addr').fill('nonexistent.invalid');
		await dialog.locator('#srtla-port').fill('5000');

		await dialog.locator('#relay-validate').click();

		const failure = dialog.getByRole('alert');
		await expect(failure).toBeVisible({ timeout: 15_000 });
		await expect(failure).toContainText('Validation failed');
		await expect(failure).toContainText('dns');

		// A failed validation blocks Save until the endpoint is corrected.
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
	});
});
