import { computedStyle, navigateTo } from './helpers/index.js';
import { expect, test } from './fixtures/index.js';
import { ShellPage } from './pages/shell.js';

test.describe('smoke', () => {
	test('desktop home renders header/logo', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop-only layout assertion');

		const shell = new ShellPage(page);
		await shell.gotoAuthed();

		await shell.assertAuthedShell();
		// First header control (theme or locale toggle) is reachable by role.
		await expect(shell.header.getByRole('button').first()).toBeVisible();

		// Exercise the desktop nav rail via the helper (no hardcoded tab ids).
		// navigateTo asserts aria-current='page' after each click — the web-first
		// replacement for the old screenshot. Hit a non-default destination first
		// to guarantee a real navigation (idempotent on the already-active tab).
		await navigateTo(page, 'network');
		await navigateTo(page, 'live');
	});

	test('mobile home renders bottom nav', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'mobile-only layout assertion');

		const shell = new ShellPage(page);
		await shell.gotoAuthed();

		await shell.assertAuthedShell();
		// The mobile bottom dock resolves through the same helper; aria-current
		// assertions prove the dock is mounted and interactive in mobile layout.
		await navigateTo(page, 'network');
		await navigateTo(page, 'live');
	});

	test('helpers drive theme + locale onto <html>', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'run once, on desktop');

		const shell = new ShellPage(page);
		await shell.gotoAuthed();

		await shell.setTheme('dark');
		await shell.setLocale('de');
		await page.reload();

		const html = page.locator('html');
		await expect(html).toHaveClass(/dark/);
		await expect(html).toHaveAttribute('lang', 'de');

		const bg = await computedStyle(page, 'body', 'background-color');
		expect(bg).not.toEqual('');

		// Re-auth after reload, then confirm navigation still works.
		await shell.gotoAuthed();
		await navigateTo(page, 'network');
	});
});
