/**
 * CeraUI E2E base fixtures.
 * See PLAYBOOK.md for the assertion decision tree and usage examples.
 *
 * This module re-exports everything from @playwright/test so specs can import
 * { test, expect } exclusively from here.
 */
import { test as base, type Page } from '@playwright/test';

import { ensureAuthenticated } from '../helpers/index.js';

export { expect } from '@playwright/test';

type Fixtures = {
	authedPage: Page;
};

export const test = base.extend<Fixtures>({
	// Override page to add screenshot guard in non-@visual tests.
	page: async ({ page }, use, testInfo) => {
		const isVisual =
			testInfo.tags.includes('@visual') || testInfo.title.includes('@visual');
		if (!isVisual) {
			// Mechanically forbid screenshots in functional tests.
			const originalScreenshot = page.screenshot.bind(page);
			// biome-ignore lint/suspicious/noExplicitAny: intentional override for guard
			(page as any).screenshot = async (
				..._args: Parameters<typeof originalScreenshot>
			) => {
				throw new Error(
					'Screenshots are forbidden in functional tests. Tag the test @visual or assert via ARIA/role/web-first assertions.',
				);
			};
		}
		await use(page);
	},

	// authedPage: navigate to / and ensure the authenticated shell is visible.
	authedPage: async ({ page }, use) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		await use(page);
	},
});
