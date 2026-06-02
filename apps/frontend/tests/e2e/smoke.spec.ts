import { expect, test } from '@playwright/test';

import {
	computedStyle,
	ensureAuthenticated,
	evidencePath,
	navigateTo,
	setLocale,
	setTheme,
} from './helpers';

test.describe('smoke', () => {
	test('desktop home renders header/logo', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop-only layout assertion');

		await page.goto('/');
		await ensureAuthenticated(page);

		const header = page.locator('header').first();
		await expect(header).toBeVisible();
		await expect(header.getByRole('button').first()).toBeVisible();
		await expect(page.locator('#nav-tab-live')).toBeVisible();

		await page.screenshot({ path: evidencePath('task-5-smoke-desktop.png'), fullPage: true });
	});

	test('mobile home renders bottom nav', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'mobile-only layout assertion');

		await page.goto('/');
		await ensureAuthenticated(page);

		await expect(page.locator('header').first()).toBeVisible();
		await expect(page.locator('#mobile-nav-tab-live')).toBeVisible();

		await page.screenshot({ path: evidencePath('task-5-smoke-mobile.png'), fullPage: true });
	});

	test('helpers drive theme + locale onto <html>', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'run once, on desktop');

		await page.goto('/');
		await ensureAuthenticated(page);

		await setTheme(page, 'dark');
		await setLocale(page, 'de');
		await page.reload();

		const html = page.locator('html');
		await expect(html).toHaveClass(/dark/);
		await expect(html).toHaveAttribute('lang', 'de');

		const bg = await computedStyle(page, 'body', 'background-color');
		expect(bg).not.toEqual('');

		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
	});
});
