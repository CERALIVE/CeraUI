/**
 * Network functional spec — destination load + 4 dialog coverage.
 * Mock: MOCK_SCENARIO=multi-modem-wifi (3 modems + WiFi). Deterministic.
 * Open/close scope only: no connect/disconnect/forget mutations.
 * See PLAYBOOK.md for assertion decision tree.
 */
import { expect, test } from './fixtures/index.js';
import { NetworkPage } from './pages/network.js';
import { ShellPage } from './pages/shell.js';

test.describe('Network destination', () => {
	test('loads the authenticated Network view', async ({ authedPage: page }) => {
		const shell = new ShellPage(page);
		await shell.navigate('network');
		await shell.assertAuthedShell();
		// Network destination heading visible (mock has modems, WiFi, Ethernet, hotspot).
		await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible();
	});

	test('ModemConfig dialog — first modem located dynamically', async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openModemConfig();
		// Dialog title is the modem's reported name (DYNAMIC) — assert by role only.
		await expect(page.getByRole('dialog')).toBeVisible();
		await network.closeModemConfig();
		await expect(page.getByRole('dialog')).toBeHidden();
	});

	test('Hotspot dialog opens and closes', async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();
		await expect(page.getByRole('dialog', { name: 'Configure Hotspot' })).toBeVisible();
		await network.closeHotspot();
		await expect(page.getByRole('dialog', { name: 'Configure Hotspot' })).toBeHidden();
	});

	test('WiFi selector opens and waits for scan results', async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openWifiSelector();
		await expect(page.getByRole('dialog', { name: 'Available Networks' })).toBeVisible();
		await network.closeWifiSelector();
		await expect(page.getByRole('dialog', { name: 'Available Networks' })).toBeHidden();
	});

	test('Netif dialog opens and closes', async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openNetif();
		await expect(page.getByRole('dialog', { name: 'Configure' })).toBeVisible();
		await network.closeNetif();
		await expect(page.getByRole('dialog', { name: 'Configure' })).toBeHidden();
	});
});
