import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';

/**
 * layout-designer.visual.spec.ts — @visual baselines for the layout designer.
 *
 * Two states are worth pixels: the inset placed over the preview's empty stage
 * (the preview off, so no decoded frame enters the pixels) and the layout
 * radios with the seventh, `custom`, chosen. Both run on the `caps-full` mock,
 * which advertises `composition-geometry`. Desktop only: mobile baselines are
 * not tracked (`.gitignore`), and the functional spec covers the phone layout.
 */

test.use({ backendScenario: 'caps-full' });

test.describe('@visual layout designer', () => {
	test.beforeEach(async ({ page, backendRpc }) => {
		await backendRpc.call(['streaming', 'setConfig'], {
			source: 'usb',
			srtla_addr: '127.0.0.1',
			srtla_port: 5000,
			composition: {
				secondary_input_id: 'hdmi',
				layout: 'custom',
				alpha: 1,
				rect: { x: 0.05, y: 0.45, width: 0.35, height: 0.35 },
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
	});

	test.afterEach(async ({ backendRpc }) => {
		await backendRpc.call(['streaming', 'setConfig'], { composition: null });
	});

	test('@visual the inset placed on the preview', { tag: '@visual' }, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'mobile baselines are not tracked');
		const preview = page.getByTestId('program-desk').getByTestId('preview');
		await expect(preview.getByTestId('layout-inset')).toBeVisible();
		await expect(preview).toHaveScreenshot('layout-designer-inset.png', { maxDiffPixels: 100 });
	});

	test('@visual the layout radios with custom chosen', { tag: '@visual' }, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'mobile baselines are not tracked');
		const radios = page.getByTestId('composition-layout-selector');
		await expect(page.getByTestId('composition-layout-custom')).toHaveAttribute('aria-checked', 'true');
		await expect(radios).toHaveScreenshot('layout-designer-radios.png', { maxDiffPixels: 100 });
	});
});
