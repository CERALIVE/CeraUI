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

/**
 * FIXED OVERLAYS RE-COMPOSITE INTO A STITCHED ELEMENT SCREENSHOT.
 *
 * At 390px this card is taller than the viewport, so Playwright captures it by
 * scrolling and stitching — and anything `position: fixed` is painted into each
 * tile at whatever offset the stitch reaches, which is not the same between two
 * runs. Two overlays sit over this card and neither belongs to it:
 *
 *   • the mobile dock (nav tabs + HUD) on the bottom edge — measured as a stable
 *     ~1900px difference, a baseline with the dock covering CLIENT ZONES against
 *     a verify run with it absent, which no retry settles;
 *   • the svelte-sonner toast host, whose presence is timing-dependent — the
 *     residual ~118px at the card's trailing edge once the dock was gone.
 *     `mask.css` already neutralises it for the specs that load it; this one
 *     takes element screenshots and does not.
 *
 * Both are removed from the capture rather than masked: an element screenshot's
 * geometry does not depend on either, and on desktop the dock is not mounted at
 * all, so the first rule is inert there.
 */
const OVERLAY_STABILIZE =
	'.fixed.inset-x-0.bottom-0.z-40{display:none !important}' +
	'[data-sonner-toaster]{display:none !important}';

test.describe('@visual Internet-Sharing card', () => {
	let wire: SharingWire;

	test.beforeEach(async ({ page }) => {
		wire = await installSharingWire(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		await wire.publish();
		await expect(page.locator(CARD)).toBeVisible();
		await page.addStyleTag({ content: OVERLAY_STABILIZE });
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
