import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

test.describe('System Logs export keyboard', { tag: '@desktop-only' }, () => {
	for (const width of [375, 1280]) {
		test(`keeps the keyboard in a refused export and restores the opener at ${width}px`, async ({ page, pageRpc }) => {
			const pending = Promise.withResolvers<() => void>();
			let requests = 0;
			await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
				const server = socket.connectToServer();
				pageRpc.bindConnectionLifecycle(socket, server);
				socket.onMessage((message) => {
					const request: { id?: unknown; path?: readonly string[] } =
						typeof message === 'string' ? JSON.parse(message) : {};
					if (request.path?.join('.') === 'logs.createExport') {
						requests++;
						pending.resolve(() => socket.send(JSON.stringify({
							id: request.id, error: { message: 'CREDENTIALS_LOADING', code: 'INTERNAL_ERROR' },
						})));
						return;
					}
					server.send(message);
				});
				server.onMessage((message) => {
					socket.send(message);
					pageRpc.acceptServerMessage(message);
				});
			});
			await page.setViewportSize({ width, height: 812 });
			await page.goto('/');
			await ensureAuthenticated(page);
			await navigateTo(page, 'settings');
			await page.getByTestId('settings-entry-logs').click();
			const logs = page.getByRole('dialog', { name: 'System Logs' });
			if (width < 1024) await logs.getByRole('tab', { name: 'Storage' }).click();

			const trigger = logs.getByTestId('sharing-open-export');
			await trigger.focus();
			await page.keyboard.press('Enter');
			const confirm = page.getByRole('dialog', { name: 'Export this view' });
			const download = confirm.getByRole('button', { name: 'Download export' });
			const cancel = confirm.getByRole('button', { name: 'Cancel' });
			const close = confirm.getByTestId('app-dialog-close');
			await download.focus();
			await page.keyboard.press('Enter');
			const refuse = await pending.promise;
			await expect(download).toBeDisabled();
			await expect(cancel).toBeFocused();
			refuse();
			await expect(confirm.getByRole('alert')).toBeVisible();
			await expect(cancel).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(download).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(close).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(download).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(confirm).toHaveCount(0);
			await expect(trigger).toBeFocused();
			expect(requests).toBe(1);
		});
	}
});
