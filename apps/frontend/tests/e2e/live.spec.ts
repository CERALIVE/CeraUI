/**
 * Live functional spec — destination load + Encoder/Audio/Server dialog coverage.
 * Open/close scope only: no stream start, no form submission, no HUD live values.
 * See PLAYBOOK.md for the assertion decision tree.
 */
import { expect, test as base } from './fixtures/index.js';
import { LivePage } from './pages/live.js';
import { ShellPage } from './pages/shell.js';

// Concurrent specs (field-lock, stream-health) inject is_streaming:true via
// dev.emit, which the backend broadcasts to EVERY authed client — locking these
// config rows behind "Stop stream to change". Force incoming status frames back
// to is_streaming:false so the Live controls stay reachable regardless of what
// another worker broadcasts. Installed via a page-fixture override so it runs
// before authedPage navigates.
function pinNotStreaming(): void {
	const Native = window.WebSocket;
	class Hooked extends Native {
		set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
			if (handler === null) {
				super.onmessage = handler;
				return;
			}
			super.onmessage = (ev: MessageEvent) => {
				try {
					const parsed = JSON.parse(ev.data);
					if (parsed?.status?.is_streaming) {
						parsed.status.is_streaming = false;
						handler.call(this, new MessageEvent('message', { data: JSON.stringify(parsed) }));
						return;
					}
				} catch {
					/* non-JSON frame — pass through */
				}
				handler.call(this, ev);
			};
		}

		get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
			return super.onmessage;
		}
	}
	window.WebSocket = Hooked as typeof WebSocket;
}

const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(pinNotStreaming);
		await use(page);
	},
});

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
