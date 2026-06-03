import { test, expect } from '../fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo } from '../helpers/index.js';

const SWEEP_LABEL = process.env.SWEEP_LABEL ?? 'multimodem';

test.describe('data-previsualization @visual', () => {
	test(
		'full-page evidence of the previsualized Network view @visual',
		{ tag: '@visual' },
		async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'desktop-only sweep');

			await page.goto('/');
			await ensureAuthenticated(page);
			await navigateTo(page, 'network');

			await expect(
				page.getByRole('heading', { name: 'Cellular', level: 2 }),
			).toBeVisible();

			await page.screenshot({
				path: evidencePath(`task-22-sweep-${SWEEP_LABEL}.png`),
				fullPage: true,
			});
		},
	);
});
