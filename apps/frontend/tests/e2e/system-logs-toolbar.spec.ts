import { readFile } from 'node:fs/promises';

import { expect, test } from './fixtures/index.js';
import { type SystemLogsTab, SystemLogsPage } from './pages/system-logs.js';

/**
 * The logs toolbar's Support bundle and Export logs stay fully in view, without
 * scrolling, on every tab of every layout (phone, tablet, touch kiosk, desktop
 * and e-ink), and a phone exports from Events, where Downloads is not mounted.
 */

const LAYOUTS = [
	{ name: 'phone', size: { width: 375, height: 812 }, touch: false, eink: false, thumb: true },
	{ name: 'tablet', size: { width: 768, height: 1024 }, touch: false, eink: false, thumb: false },
	{ name: 'kiosk', size: { width: 1024, height: 600 }, touch: true, eink: false, thumb: true },
	{ name: 'desktop', size: { width: 1280, height: 800 }, touch: false, eink: false, thumb: false },
	{ name: 'e-ink phone', size: { width: 375, height: 812 }, touch: false, eink: true, thumb: true },
] as const;

test.describe('System Logs toolbar', { tag: '@desktop-only' }, () => {
	for (const layout of LAYOUTS) {
		test(`keeps Support bundle and Export logs in view on every tab, ${layout.name}`, async ({ page }) => {
			if (layout.eink) {
				await page.addInitScript(() => localStorage.setItem('display-profile', JSON.stringify('eink')));
			}
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size: layout.size, touch: layout.touch, scheme: 'dark' });
			if (layout.eink) await expect(page.locator('html')).toHaveAttribute('data-display', 'eink');

			const toolbar = page.getByRole('group', { name: 'Downloads' });
			const tabs: SystemLogsTab[] = layout.size.width >= 1024 ? ['events', 'raw'] : ['events', 'raw', 'storage'];
			for (const tab of tabs) {
				await logs.show(tab);
				for (const name of ['Support bundle', 'Export logs']) {
					const action = toolbar.getByRole('button', { name, exact: true });
					await expect(action).toBeInViewport({ ratio: 1 });
					// A phone is thumbed and the kiosk is touch, so both get the 44 px target.
					if (layout.thumb) expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
				}
			}
		});
	}

	test('a phone opens the explained support bundle and exports from Events', async ({ page }, testInfo) => {
		const logs = new SystemLogsPage(page);
		await logs.open({ locale: 'en', size: { width: 375, height: 812 }, touch: false, scheme: 'light' });
		await expect(page.getByTestId('sharing-group')).toHaveCount(0);
		const toolbar = page.getByRole('group', { name: 'Downloads' });

		await toolbar.getByRole('button', { name: 'Support bundle', exact: true }).click();
		const bundle = page.getByRole('dialog', { name: 'Support bundle' });
		await expect(bundle.getByTestId('sharing-bundle-about')).toHaveText(
			'One file for a helper: versions, events, recent logs and settings, with known secrets removed.',
		);
		await expect(bundle.getByTestId('sharing-bundle-sensitive')).toBeVisible();
		await expect(bundle.getByRole('button', { name: 'Download bundle' })).toBeEnabled();
		await bundle.getByRole('button', { name: 'Cancel' }).click();
		await expect(bundle).toHaveCount(0);

		await toolbar.getByRole('button', { name: 'Export logs', exact: true }).click();
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		await expect(confirm.getByTestId('sharing-export-sensitive')).toBeVisible();
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			confirm.getByRole('button', { name: 'Download export' }).click(),
		]);
		const file = testInfo.outputPath('export.txt');
		await download.saveAs(file);
		const text = await readFile(file, 'utf8');
		expect(text.slice(0, 15).toLowerCase()).not.toBe('<!doctype html>');
		expect(download.suggestedFilename()).toMatch(/\.txt$/);
	});
});
