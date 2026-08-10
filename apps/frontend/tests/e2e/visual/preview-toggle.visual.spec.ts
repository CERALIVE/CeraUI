import { expect, test } from '../fixtures/index.js';
import { bootstrapPreviewEncode } from '../preview-encode-fixture.js';

/**
 * preview-toggle.visual.spec.ts — @visual regression for the capability-gated
 * hardware-preview control (T15).
 *
 * Two states are worth pixels, and they are the two the functional specs can
 * only assert structurally:
 *
 *   1. capable — the offered control in its resting OFF state, with the
 *      "applies to the next stream" helper and the "nothing realized" active
 *      line. This is what an operator sees before touching anything.
 *   2. fallback — the requested-vs-realized disagreement: the switch ON, the
 *      active line naming `x264enc`, and the warning band carrying both the
 *      code-specific message and the refused property. The whole value of this
 *      state is that it READS as a warning rather than as ordinary chrome, and
 *      a DOM assertion cannot see that.
 *
 * Desktop only: the control is a stacked block with no responsive branch, so a
 * second viewport would buy a second baseline and no additional coverage.
 * PLAYBOOK.md: screenshots live only in `tests/e2e/visual/*.visual.spec.ts`
 * tagged @visual.
 */

const REALIZED_PROPERTY_FAILURE = {
	selected_element: 'mpph264enc',
	realized_element: 'x264enc',
	mode: 'software',
	fallback_reason: { code: 'property-failure', property: 'bps' },
} as const;

test.describe('@visual preview hardware-encode control', () => {
	test(
		'@visual capable board — the control at rest',
		{ tag: '@visual' },
		async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'one baseline; no responsive branch');

			await bootstrapPreviewEncode(page, { capability: true });

			const control = page.getByTestId('preview-encode-control');
			await expect(control).toBeVisible();
			await expect(page.getByTestId('preview-encode-switch')).toHaveAttribute(
				'aria-checked',
				'false',
			);
			await expect(page.getByTestId('preview-encode-active')).toHaveAttribute(
				'data-mode',
				'none',
			);

			await expect(control).toHaveScreenshot('preview-encode-capable.png', {
				maxDiffPixels: 50,
			});
		},
	);

	test(
		'@visual fallback — hardware requested, software realized',
		{ tag: '@visual' },
		async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'one baseline; no responsive branch');

			await bootstrapPreviewEncode(page, {
				capability: true,
				persistedRequest: 'hardware',
				realized: { ...REALIZED_PROPERTY_FAILURE },
			});

			const control = page.getByTestId('preview-encode-control');
			await expect(control).toBeVisible();
			await expect(page.getByTestId('preview-encode-fallback')).toHaveAttribute(
				'data-code',
				'property-failure',
			);
			await expect(page.getByTestId('preview-encode-fallback-property')).toHaveText('bps');

			await expect(control).toHaveScreenshot('preview-encode-fallback.png', {
				maxDiffPixels: 50,
			});
		},
	);
});
