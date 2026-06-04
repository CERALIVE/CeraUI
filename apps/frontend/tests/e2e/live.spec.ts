/**
 * Live functional spec — destination load + Encoder/Audio/Server dialog coverage.
 * Open/close scope only: no stream start, no form submission, no HUD live values.
 * See PLAYBOOK.md for the assertion decision tree.
 */
import { expect, test } from './fixtures/index.js';
import { LivePage } from './pages/live.js';
import { ShellPage } from './pages/shell.js';

test.describe('Live destination', () => {
	test('loads the authenticated Live view', async ({ authedPage: page }) => {
		const shell = new ShellPage(page);
		await shell.navigate('live');
		await shell.assertAuthedShell();

		// Main region is mounted (structural, no live numeric values).
		// Mobile nests an inner <main> inside the PWA pull-to-refresh shell, so
		// scope to the first match rather than asserting a unique role.
		await expect(page.getByRole('main').first()).toBeVisible();

		// Stream control is reachable by role+name — "Start Stream"/"Stop Stream"
		// both contain "Stream"; this proves the control is present without
		// asserting any live telemetry value.
		await expect(page.getByRole('button', { name: /stream/i }).first()).toBeVisible();
	});

	for (const [label, openFn, closeFn, dialogName] of [
		['Encoder', 'openEncoder', 'closeEncoder', 'Encoder Settings'],
		['Audio', 'openAudio', 'closeAudio', 'Audio Settings'],
		['Server', 'openServer', 'closeServer', 'Receiver Server'],
	] as const) {
		test(`${label} dialog opens and closes`, async ({ authedPage: page }) => {
			const live = new LivePage(page);
			await live.open();

			await live[openFn]();
			// Dialog visible + >=1 interactive element present (open/close scope).
			await live.assertDialogStructure(dialogName);

			await live[closeFn]();
			await expect(page.getByRole('dialog', { name: dialogName })).toBeHidden();
		});
	}
});
