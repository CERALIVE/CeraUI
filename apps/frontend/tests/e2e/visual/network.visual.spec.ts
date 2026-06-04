import { expect, test } from '../fixtures/index.js';
import { NetworkPage } from '../pages/network.js';

test.describe('@visual Network destination snapshots', () => {
	test('@visual network destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();
		await expect(page).toHaveScreenshot('network-desktop.png', {
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});
