import { expect, test } from './fixtures/index.js';
import { bootstrapPreviewEncode } from './preview-encode-fixture.js';

/**
 * T15 (ii) — a board that does NOT publish a hardware preview encoder.
 *
 * The control is ABSENT from the DOM. Not disabled, not greyed with a tooltip:
 * a greyed switch is an invitation to hunt for whatever would enable it, and on
 * a board whose HAL publishes no preview encoder descriptor there is nothing to
 * find. The two hiding readings are asserted separately because they are two
 * different facts — `false` is "this board publishes none", absent is "a legacy
 * engine never stated a capability" — and normalizing either into the other
 * would let a stored verdict outlive the engine upgrade that changes it.
 *
 * PLAYBOOK.md:39-51 — functional spec, no screenshots, no fixed delays.
 */

test.describe('preview hardware encode — incapable board', () => {
	test('an explicit preview_hw_capability:false renders no control at all', async ({ page }) => {
		await bootstrapPreviewEncode(page, { capability: false });

		await expect(page.getByTestId('preview-encode-control')).toHaveCount(0);
		await expect(page.getByTestId('preview-encode-switch')).toHaveCount(0);
		await expect(page.getByTestId('preview-encode-active')).toHaveCount(0);
		await expect(page.getByTestId('preview-encode-fallback')).toHaveCount(0);
	});

	test('an ABSENT preview_hw_capability renders no control at all', async ({ page }) => {
		await bootstrapPreviewEncode(page, { capability: 'absent' });

		await expect(page.getByTestId('preview-encode-control')).toHaveCount(0);
		await expect(page.getByTestId('preview-encode-switch')).toHaveCount(0);
	});

	test('the preview canvas itself is untouched by the missing control', async ({ page }) => {
		// The control hangs off the disclosure, not off the canvas. Hiding it must
		// not take the preview surface with it.
		await bootstrapPreviewEncode(page, { capability: false });

		await expect(page.getByTestId('preview')).toBeVisible();
		await expect(page.getByTestId('preview-encode-switch')).toHaveCount(0);
	});
});
