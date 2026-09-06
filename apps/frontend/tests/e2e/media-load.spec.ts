import { encoderLoadSchema } from '@ceraui/rpc/schemas';
import { mockIslandLoadAt } from '../../src/lib/streaming/encoder-load-island-mock';
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

test('media detail follows the wire, then degrades to the legacy clock reading', async ({ page, pageRpc }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	const snapshot = encoderLoadSchema.parse(mockIslandLoadAt(Date.now()));
	await pageRpc.call(['dev', 'emit'], { type: 'encoder-load', payload: snapshot });
	const hint = page.getByTestId('media-load-hint');
	await expect(hint).toHaveAttribute('data-core-count', '9');
	await expect(hint).not.toContainText('4242');
	const trigger = hint.getByRole('button', { name: 'Media details', exact: true });
	await trigger.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Media load', exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('media-load-detail').focus();
	await expect(dialog.getByTestId('media-load-detail')).toBeFocused();
	await expect(dialog.getByTestId('media-detail-core')).toHaveCount(9);
	await expect(dialog).toContainText('145.53%');
	await expect(dialog).toContainText('121.08%');
	await expect(dialog).toContainText('PID 4242 · index 7');
	await expect(dialog).toContainText('PID 4242 · index 9');
	await expect(dialog.locator('[data-block="rga"]')).toContainText('Not published by this driver');
	await expect(dialog.locator('[data-core="fdc48100.video-codec"]')).toContainText('Unknown');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await expect(dialog).toBeVisible();
	await pageRpc.call(['dev', 'emit'], { type: 'encoder-load', payload: encoderLoadSchema.parse({
		source: 'clk-enable-count', updatedAt: Date.now(), simulated: false,
		cores: [{ core: 'rkvenc0', kind: 'active', active: true }, { core: 'rkvenc1', kind: 'unavailable' }],
	}) });
	await expect(dialog.getByTestId('media-detail-core')).toHaveCount(0);
	await expect(dialog).not.toContainText('4242');
	await expect(dialog.getByTestId('encoder-core-value-rkvenc0')).toHaveText('Busy');
	await expect(dialog.getByTestId('encoder-core-value-rkvenc0')).not.toContainText(/\d|%/);
	await expect(dialog.getByTestId('encoder-core-value-rkvenc1')).toHaveText('Unavailable');
	await expect(dialog).toContainText('Utilization and session ownership are unknown');
	expect(errors).toEqual([]);
});
