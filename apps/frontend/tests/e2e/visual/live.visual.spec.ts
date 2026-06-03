import { expect, test } from '../fixtures/index.js';
import { LivePage } from '../pages/live.js';

test.describe('@visual Live destination snapshots', () => {
	test('@visual live destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const live = new LivePage(page);
		await live.open();
		await expect(page).toHaveScreenshot('live-desktop.png', {
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});
