/**
 * signal-indicator.visual.spec.ts — @visual regression for the unified
 * LinkIndicator component across its three real consumption surfaces.
 *
 * See PLAYBOOK.md: screenshots are ONLY permitted in tests/e2e/visual/*.visual.spec.ts
 * tagged @visual. Each test below uses the `authedPage` fixture (auth + the
 * screenshot guard live there) and pins a committed baseline via toHaveScreenshot.
 *
 * Three surfaces:
 *   1. Showcase — DevTools IdentityPreview fixture grid (11 bar states × 3 sizes
 *                 + quality-color icons). Pure literals, no live data → no mask.
 *   2. HUD      — the persistent HUD bar's per-link mini-bar cluster. The whole
 *                 fixed-width [data-hud-region] button is captured (stable
 *                 dimensions); the volatile bitrate/SoC telemetry siblings carry
 *                 `title` attributes and are hidden so the flex-1 link cluster
 *                 fills deterministically and the bars never shift. mask.css is
 *                 NOT usable here — it hides every [data-hud-region] span/svg,
 *                 including the bars under test.
 *   3. Bonded   — NetworkView BondedLinksSection. Identity-colored bars are
 *                 stable (mock signal is seeded, not random); the volatile
 *                 per-link throughput readouts carry [data-live-value] and are
 *                 neutralised by mask.css, while per-card staleness dimming
 *                 (`opacity-60`, timing-dependent) is pinned to opacity:1.
 *
 * Mock scenario: multi-modem-wifi (deterministic signal; only throughput ticks).
 * Playwright disables CSS animations in toHaveScreenshot, so the scanning-link
 * pulse is frozen to its first frame.
 */
import { expect, test } from '../fixtures/index.js';
import { navigateTo } from '../helpers/index.js';
import { DevToolsPage } from '../pages/devtools.js';

const maskStyle = new URL('./mask.css', import.meta.url).pathname;

// Hide the HUD's volatile telemetry (bitrate + SoC readouts both carry a `title`;
// the LinkIndicator bars and L-labels carry none) so the flex-1 link cluster
// occupies a deterministic width and the bars hold a fixed position.
const HUD_STABILIZE = '[data-hud-region] [title]{display:none !important}';

// Pin per-card staleness dimming (opacity-60 / opacity-50) inside the bonded
// section: it flips on slower runs and would otherwise dim a whole card. The
// LinkIndicator renders empty bars via background color, not element opacity,
// so forcing opacity:1 does not alter the indicator states under test.
const BONDED_STABILIZE =
	'section[aria-label="Bonded Links"] *{opacity:1 !important;transition:none !important}';

test.describe('@visual LinkIndicator surfaces', () => {
	test(
		'@visual signal-indicator showcase grid',
		{ tag: '@visual' },
		async ({ authedPage: page }) => {
			const devtools = new DevToolsPage(page);
			await devtools.open();

			const showcase = devtools.showcaseContainer;
			await expect(showcase).toBeVisible();

			// Static fixture grid — no live values, so no mask is needed.
			await expect(showcase).toHaveScreenshot('signal-indicator-showcase.png', {
				maxDiffPixels: 50,
			});
		},
	);

	test(
		'@visual HUD per-link bar cluster',
		{ tag: '@visual' },
		async ({ authedPage: page }) => {
			// HUD is persistent across destinations; Live is sufficient.
			await navigateTo(page, 'live');

			const hud = page.locator('[data-hud-region]').filter({ visible: true }).first();
			await expect(hud).toBeVisible();

			await page.addStyleTag({ content: HUD_STABILIZE });

			await expect(hud).toHaveScreenshot('hud-link-cluster.png', {
				maxDiffPixels: 50,
			});
		},
	);

	test(
		'@visual BondedLinksSection network list',
		{ tag: '@visual' },
		async ({ authedPage: page }) => {
			await navigateTo(page, 'network');

			// <section aria-label="Bonded Links"> → implicit role="region".
			const bonded = page.getByRole('region', { name: 'Bonded Links' });
			await expect(bonded).toBeVisible();

			await page.addStyleTag({ content: BONDED_STABILIZE });

			await expect(bonded).toHaveScreenshot('bonded-links-section.png', {
				stylePath: maskStyle,
				maxDiffPixels: 100,
			});
		},
	);
});
