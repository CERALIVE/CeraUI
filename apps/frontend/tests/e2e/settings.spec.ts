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
 * doing so would reboot/shutdown the dev backend and break every later test.
 * We prove the backend survived by opening another dialog (Versions) afterward.
 */
import { expect } from '@playwright/test';

import { test } from './fixtures/index.js';
import { SettingsPage } from './pages/settings.js';
import { ShellPage } from './pages/shell.js';

test.describe('Settings destination', () => {
	test('loads the authenticated Settings view', async ({ authedPage: page }) => {
		const shell = new ShellPage(page);
		await shell.navigate('settings');
		await shell.assertAuthedShell();
		// Two <main> elements exist (PWA pull-to-refresh wrapper + content);
		// assert the outer landmark is visible.
		await expect(page.getByRole('main').first()).toBeVisible();
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
