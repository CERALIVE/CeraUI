import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo } from '../helpers/index.js';
import {
	CAPABLE_CAPABILITIES,
	LEGACY_CAPABILITIES,
	capableDetails,
	installUpdateWire,
	orchestratorState,
} from '../helpers/update-wire.js';

/**
 * Todo 41 — evidence captures of the device update surfaces, @visual.
 *
 * The PNGs are EVIDENCE written to the gitignored `test-results/`, never a
 * regression baseline: every capture is preceded by the assertion that each
 * block it promises is WHOLLY in the frame. The functional contract lives in
 * `update-system.spec.ts`.
 *
 * `toBeVisible()` cannot make that promise. It passes for an element clipped by
 * its scroll container, and the Updates dialog scrolls its own body inside an
 * `85svh` surface (AppDialog), with the held cellular approval in the LAST
 * section, far below that body's fold: two captures once shipped without the
 * block they were named for. `toBeInViewport({ ratio: 1 })` is answered by
 * IntersectionObserver, which clips by every scrolling ancestor.
 *
 * A dialog is therefore captured as the viewport the operator sees, after its
 * body is scrolled to the promised block; a full-page capture grows the
 * document, never the dialog's own scroll box. The approval and the slot table
 * are too far apart for one frame, so the capable image takes two captures.
 */

const UPDATES_DIALOG = 'Software Updates';

/** Drain finite animations (a dialog's entrance) so the frame measured is the frame captured. */
function settleMotion(page: Page): Promise<void> {
	return page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
				)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
}

/**
 * Scroll each promised block into its scroll container, then require ALL of them
 * wholly on screen at once, so a later scroll that pushes an earlier block out
 * fails here rather than in a picture nobody measured.
 */
async function expectInFrame(page: Page, blocks: readonly Locator[]): Promise<void> {
	for (const block of blocks) {
		await block.scrollIntoViewIfNeeded();
	}
	await settleMotion(page);
	for (const block of blocks) {
		await expect(block).toBeInViewport({ ratio: 1 });
	}
}

test.describe('device update surfaces @visual', () => {
	test.beforeEach(({ browserName }) => {
		test.skip(browserName !== 'chromium', 'single-browser evidence set');
	});

	test('capable-image Updates dialog with a held cellular image @visual', { tag: '@visual' }, async ({
		page,
	}, testInfo) => {
		await installUpdateWire(page, {
			orchestrator: orchestratorState('os-activation-armed'),
			fakes: {
				'system.getUpdateCapabilities': CAPABLE_CAPABILITIES,
				'system.getUpdateDetails': capableDetails(),
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-updates').click();
		const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
		const heldImage = dialog.getByTestId('update-cellular-pending');
		const slots = dialog.getByTestId('updates-slots');
		await expect(heldImage).toBeVisible();
		await expect(slots).toBeVisible();

		await expectInFrame(page, [heldImage]);
		await page.screenshot({
			path: evidencePath(`todo-41-updates-capable-${testInfo.project.name}.png`),
		});

		await expectInFrame(page, [slots]);
		await page.screenshot({
			path: evidencePath(`todo-41-updates-capable-slots-${testInfo.project.name}.png`),
		});
	});

	test('legacy-image Updates dialog @visual', { tag: '@visual' }, async ({ page }, testInfo) => {
		await installUpdateWire(page, {
			fakes: { 'system.getUpdateCapabilities': LEGACY_CAPABILITIES },
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-updates').click();
		const dialog = page.getByRole('dialog', { name: UPDATES_DIALOG });
		const notice = dialog.getByTestId('update-legacy-notice');
		await expect(notice).toBeVisible();
		await expectInFrame(page, [notice]);
		await page.screenshot({
			path: evidencePath(`todo-41-updates-legacy-${testInfo.project.name}.png`),
		});
	});

	test('Live cockpit with the Go-Live band and the global badge @visual', { tag: '@visual' }, async ({
		page,
	}, testInfo) => {
		const wire = await installUpdateWire(page, {
			orchestrator: orchestratorState('committing', { percent: 64, etaSeconds: 150 }),
			startable: true,
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		wire.pushStartable();
		const band = page.getByTestId('update-refusal-band');
		const badge = page.getByTestId('update-orchestrator-badge');
		await expect(band).toBeVisible();
		await expect(badge).toBeVisible();
		// The page itself scrolls here, so the full-page capture holds the viewport
		// and the rest of the cockpit; in-viewport is the stricter of the two.
		await expectInFrame(page, [band, badge]);
		await page.screenshot({
			path: evidencePath(`todo-41-live-refusal-${testInfo.project.name}.png`),
			fullPage: true,
		});
	});
});
