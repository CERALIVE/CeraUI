import { expect, test } from './fixtures/index.js';
import { SystemLogsPage } from './pages/system-logs.js';

for (const locale of ['en', 'ar', 'de'] as const) {
	for (const size of [{ width: 390, height: 440 }, { width: 360, height: 360 }, { width: 320, height: 480 }] as const) {
		test(`${locale} ${size.width}x${size.height}: expanded Raw filters leave scrollable results @mobile-only`, async ({ page }, info) => {
			const logs = new SystemLogsPage(page);
			await logs.open({ locale, size: { width: size.width, height: 844 }, touch: false, scheme: 'light' });
			await logs.show('raw');
			const toggle = page.getByTestId('raw-filters-toggle');
			await toggle.click();
			await page.setViewportSize(size);
			await logs.settle();
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');

			const results = page.getByTestId('raw-scroller');
			const viewport = await results.evaluate((el) => ({
				height: el.clientHeight,
				contentHeight: el.scrollHeight,
				renderedRows: el.querySelectorAll('[data-testid="raw-row"]').length,
			}));
			await info.attach('raw viewport', { body: JSON.stringify(viewport), contentType: 'application/json' });
			expect(viewport.contentHeight).toBeGreaterThan(88);
			// Leave room for at least two minimum row targets, not just a sliver of the list.
			expect(viewport.height, JSON.stringify(viewport)).toBeGreaterThanOrEqual(88);
			await results.scrollIntoViewIfNeeded();
			await expect(results).toBeInViewport({ ratio: 1 });
			await expect(results.getByTestId('raw-row').first()).toBeInViewport();
			await results.hover();
			await page.mouse.wheel(0, 65);
			await expect.poll(() => results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

			// The lower filters must still be reachable by scrolling their own region.
			const time = page.getByTestId('raw-time');
			await time.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
			await expect(time).toBeInViewport({ ratio: 1 });
			const timeSize = await time.boundingBox();
			expect(timeSize?.width).toBeGreaterThanOrEqual(44);
			expect(timeSize?.height).toBeGreaterThanOrEqual(44);
			await time.click();
			await expect(page.getByRole('listbox')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('listbox')).toHaveCount(0);
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			// At the shortest height the outer Raw panel may also need to scroll.
			await results.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
			await expect(results).toBeInViewport({ ratio: 1 });
		});
	}
}
