import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated } from './helpers/index.js';

/**
 * The app shell takes the graphite palette and the app typeface: the page
 * scrollbar's thumb and track resolve from --muted-foreground and --background
 * in both themes, and a toast is set in the body's font, not sonner's own
 * system font stack.
 */

for (const scheme of ['dark', 'light'] as const) {
	test(`the page scrollbar is drawn from the graphite tokens in ${scheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), scheme);
		await page.goto('/');
		await ensureAuthenticated(page);
		await (scheme === 'dark'
			? expect(page.locator('html')).toHaveClass(/\bdark\b/)
			: expect(page.locator('html')).not.toHaveClass(/\bdark\b/));

		const colors = await page.evaluate(() => {
			const probe = document.createElement('div');
			probe.style.color = 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)';
			probe.style.backgroundColor = 'var(--background)';
			document.body.append(probe);
			const { color, backgroundColor } = getComputedStyle(probe);
			probe.remove();
			return {
				scrollbar: getComputedStyle(document.documentElement).scrollbarColor,
				thumb: color,
				track: backgroundColor,
				page: getComputedStyle(document.body).backgroundColor,
			};
		});
		expect(colors.scrollbar).toBe(`${colors.thumb} ${colors.track}`);
		expect(colors.track).toBe(colors.page);
	});
}

test('a toast is set in the app typeface', async ({ page, pageRpc }) => {
	await page.goto('/');
	await ensureAuthenticated(page);
	await pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: {
			show: [
				{
					name: 'app-shell-toast-font',
					type: 'info',
					msg: 'App shell toast font',
					is_dismissable: true,
					is_persistent: false,
					duration: 60,
				},
			],
		},
	});
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'App shell toast font' });
	await expect(toast).toBeVisible();

	const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
	expect(bodyFont).not.toBe('');
	expect(await toast.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(bodyFont);
});
