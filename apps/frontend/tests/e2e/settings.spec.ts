/**
 * Settings destination — functional spec covering all 7 config dialogs.
 *
 * Scope: each dialog opens, asserts structural soundness, and closes. No live
 * values, no screenshots, no fixed-delay waits — see PLAYBOOK.md for the
 * assertion decision tree.
 *
 * CRITICAL: PowerDialog exposes destructive actions (reboot / power off), each
 * gated behind a nested "Are you sure?" confirmation. This spec asserts those
 * destructive triggers are PRESENT but NEVER clicks the confirmation primary —
 * doing so would exercise worker-wide disconnect state and invalidate later
 * tests assigned to that worker backend. We prove the backend survived by
 * opening another dialog (Versions) afterward.
 */
import type { DeviceStats, IfaceRxTxStat } from '@ceraui/rpc/schemas';
import { expect, type WebSocketRoute } from '@playwright/test';

import ar from '../../../../packages/i18n/messages/ar.json' with { type: 'json' };
import de from '../../../../packages/i18n/messages/de.json' with { type: 'json' };
import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import fr from '../../../../packages/i18n/messages/fr.json' with { type: 'json' };
import ja from '../../../../packages/i18n/messages/ja.json' with { type: 'json' };
import ptBR from '../../../../packages/i18n/messages/pt-BR.json' with { type: 'json' };
import { test } from './fixtures/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { ensureAuthenticated, navigateTo, setLocale } from './helpers/index.js';
import { settleDestination } from './helpers/modem-containment.js';
import { expectTextFits, probeTextFit } from './helpers/text-fit.js';
import { SettingsPage } from './pages/settings.js';
import { ShellPage } from './pages/shell.js';

test.describe('Settings destination', () => {
	test('loads the authenticated Settings view', async ({ authedPage: page }) => {
		const shell = new ShellPage(page);
		await shell.navigate('settings');
		await shell.assertAuthedShell();
		await expect(page.getByRole('main')).toBeVisible();
	});

	// Non-destructive dialogs: open → assert structure → close. PowerDialog is
	// covered separately below because of its destructive confirmation step.
	const dialogs = [
		['Cloud Remote', 'openCloudRemote', 'closeCloudRemote', 'Cloud Remote Server'],
		['Password', 'openPassword', 'closePassword', 'Device Password'],
		['SSH', 'openSsh', 'closeSsh', 'SSH Access'],
		['Logs', 'openLogs', 'closeLogs', 'System Logs'],
		['Updates', 'openUpdates', 'closeUpdates', 'Software Updates'],
		['Versions', 'openVersions', 'closeVersions', 'Device Versions'],
	] as const;

	for (const [label, openFn, closeFn, dialogName] of dialogs) {
		test(`${label} dialog opens, is structurally sound, and closes`, async ({
			authedPage: page,
		}) => {
			const settings = new SettingsPage(page);
			await settings.open();
			await settings[openFn]();
			await settings.assertDialogStructure(dialogName);
			await settings[closeFn]();
			await expect(page.getByRole('dialog', { name: dialogName })).toBeHidden();
		});
	}

	test('Power dialog — destructive triggers present, backend survives', async ({
		authedPage: page,
	}) => {
		const settings = new SettingsPage(page);
		await settings.open();

		// openPower() asserts the in-dialog "Reboot" and "Power Off" triggers are
		// visible AND that the point-of-no-return "Are you sure?" confirmation is
		// NOT open. It never clicks a destructive button.
		await settings.openPower();

		const dialog = page.getByRole('dialog', { name: 'Reboot / Power' });
		await expect(dialog).toBeVisible();
		// Explicit, self-documenting destructive-safety assertions. NEVER click.
		await expect(dialog.getByRole('button', { name: 'Reboot' })).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Power Off' })).toBeVisible();
		// Hard guard: the destructive confirmation must remain closed.
		await expect(page.getByRole('dialog', { name: 'Are you sure?' })).toBeHidden();

		await settings.closePower();

		// Prove the backend is still alive after the Power dialog: a subsequent
		// dialog must open and close normally. If the device had rebooted/shut
		// down, the socket would be dead and this would fail.
		await settings.openVersions();
		await settings.assertDialogStructure('Device Versions');
		await settings.closeVersions();
	});
});

// The narrowest phone in the longer catalogs, in RTL and in CJK, plus English
// at the width the clipping was first reported on.
const PHONE_LAYOUTS = [
	{ code: 'en', width: 390, messages: en },
	{ code: 'de', width: 320, messages: de },
	{ code: 'fr', width: 320, messages: fr },
	{ code: 'pt-BR', width: 320, messages: ptBR },
	{ code: 'ar', width: 320, messages: ar },
	{ code: 'ja', width: 320, messages: ja },
] as const;

// A reading as wide as a busy uplink's, on the interface name the Rock bench's
// HiLink stick really enumerates as (helpers/twin-bond-wire.ts).
const WIDE_NETWORK: IfaceRxTxStat = {
	iface: 'enx0c5b8f279a64',
	txBytesPerSec: 655_360,
	rxBytesPerSec: 1_363_149,
};

for (const { code, width, messages } of PHONE_LAYOUTS) {
	test.describe(`Settings rows on a ${width} px phone in ${code}`, { tag: '@mobile-only' }, () => {
		test.use({ viewport: { width, height: 720 } });

		test('each row title, description and device reading is painted whole', async ({
			authedPage: page,
		}) => {
			// Patched onto the device's own frames, so its heartbeat cannot replace
			// the reading between the seed and the measurement.
			let device: WebSocketRoute | undefined;
			await page.routeWebSocket(
				(url) => isBackendSocket(url) && url.pathname === '/ws',
				(socket) => {
					device = socket;
					const server = socket.connectToServer();
					server.onMessage((message) => {
						if (typeof message !== 'string') {
							socket.send(message);
							return;
						}
						const frame = JSON.parse(message) as { 'device-stats'?: DeviceStats };
						if (frame['device-stats']) frame['device-stats'].ifaceRxTx = WIDE_NETWORK;
						socket.send(JSON.stringify(frame));
					});
				},
			);
			await setLocale(page, code);
			await page.goto('/');
			await ensureAuthenticated(page);
			await expect(page.locator('html')).toHaveAttribute('lang', code);
			await expect(page.locator('html')).toHaveAttribute('dir', code === 'ar' ? 'rtl' : 'ltr');
			await navigateTo(page, 'settings');
			await settleDestination(page);

			// Paired but offline: the hint whose last words are the news ("Reconnecting…").
			if (!device) throw new Error('the app socket did not open through the wire fixture');
			device.send(
				JSON.stringify({ config: { remote_key: 'e2e-remote-key' }, 'remote-control': { connected: false } }),
			);
			const remote = page.getByTestId('remote-control-status');
			await expect(remote).toHaveAttribute('data-status', 'paired-disconnected');
			await page.evaluate(() => document.fonts.ready);

			const rows = [
				[
					page.getByTestId('settings-locale-selector').locator('xpath=..'),
					['settings.appearance.language', 'settings.appearance.languageDesc'],
				],
				[
					page.getByTestId('settings-theme-toggle').locator('xpath=..'),
					['settings.appearance.theme', 'settings.appearance.themeDesc'],
				],
				[page.getByTestId('settings-autostart'), ['settings.index.autostart', 'settings.index.autostartDesc']],
				[
					page.getByTestId('settings-entry-devicePassword'),
					['settings.index.devicePassword', 'settings.index.devicePasswordDesc'],
				],
				[page.getByTestId('settings-entry-cloud'), ['settings.index.cloudRemote', 'settings.index.cloudRemoteDesc']],
				[page.getByTestId('settings-entry-updates'), ['settings.index.updates', 'settings.index.updatesDesc']],
				[remote, ['settings.remoteControl.disconnected', 'settings.remoteControl.disconnectedHint']],
			] as const;
			for (const [row, keys] of rows) {
				await row.scrollIntoViewIfNeeded();
				for (const key of keys) {
					const text = row.getByText(messages[key], { exact: true });
					await expect(text).toBeVisible();
					expectTextFits(await probeTextFit(text, row), `${code} ${width}px ${key}`);
				}
			}

			// Device Stats readings are plain text with no fuller copy anywhere on the
			// page: each part of a secondary row and of a clock row must stay whole.
			const readings = page
				.getByTestId('device-stats')
				.locator('[data-tier="primary"] > span, [data-tier="secondary"], [data-policy-count]');
			await expect(page.getByTestId('device-stat-network')).toContainText(WIDE_NETWORK.iface);
			for (const reading of await readings.all()) {
				await reading.scrollIntoViewIfNeeded();
				for (const part of await reading.locator('span').all()) {
					const holdsText = await part.evaluate((el) =>
						[...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()),
					);
					if (!holdsText) continue;
					expectTextFits(await probeTextFit(part, reading), `${code} ${width}px device stats`);
				}
			}

			const currentLocale = page.getByTestId(`locale-option-${code}`);
			await page.getByTestId('settings-locale-selector').getByTestId('locale-selector').click();
			await expect(currentLocale).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(currentLocale).toBeHidden();

			const darkTheme = page.getByTestId('theme-option-dark');
			await page.getByTestId('settings-theme-toggle').getByRole('button').focus();
			await page.keyboard.press('Enter');
			await expect(darkTheme).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(darkTheme).toBeHidden();
		});
	});
}
