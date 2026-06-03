import { expect, test } from '../fixtures/index.js';
import { SettingsPage } from '../pages/settings.js';

test.describe('@visual Settings destination snapshots', () => {
	test('@visual settings destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const settings = new SettingsPage(page);
		await settings.open();
		await expect(page).toHaveScreenshot('settings-desktop.png', {
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});
