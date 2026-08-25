import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';
import {
	degradedUplinks,
	healthyThreeUplinks,
	installSharingWire,
	type SharingWire,
	steeringUnavailable,
} from '../helpers/sharing-wire.js';

/**
 * Visual baselines for the Internet-Sharing card.
 *
 * Element screenshots rather than page ones: the card sits beneath live
 * telemetry whose numbers move on every tick, so a full-page baseline would
 * flake on data this card does not own. The functional assertions are in
 * `../sharing-surface.spec.ts` — these are EVIDENCE, not the check.
 */

const CARD = '[data-testid="sharing-section"]';

test.describe('@visual Internet-Sharing card', () => {
	let wire: SharingWire;

	test.beforeEach(async ({ page }) => {
		wire = await installSharingWire(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		await wire.publish();
		await expect(page.locator(CARD)).toBeVisible();
	});

	test('@visual healthy three-uplink baseline', { tag: '@visual' }, async ({ page }) => {
		await wire.set(healthyThreeUplinks());
		await expect(page.getByTestId('sharing-uplink-wlan0')).toBeVisible();
		await expect(page.locator(CARD)).toHaveScreenshot('sharing-healthy.png', {
			maxDiffPixels: 100,
		});
	});

	test('@visual degraded baseline', { tag: '@visual' }, async ({ page }) => {
		await wire.set(degradedUplinks());
		await expect(page.getByTestId('sharing-band-no-healthy-uplink')).toBeVisible();
		await expect(page.locator(CARD)).toHaveScreenshot('sharing-degraded.png', {
			maxDiffPixels: 100,
		});
	});

	test('@visual steering-unavailable baseline', { tag: '@visual' }, async ({ page }) => {
		await wire.set(steeringUnavailable());
		await expect(page.getByTestId('sharing-band-steering-unavailable')).toBeVisible();
		await expect(page.locator(CARD)).toHaveScreenshot('sharing-steering-unavailable.png', {
			maxDiffPixels: 100,
		});
	});
});
