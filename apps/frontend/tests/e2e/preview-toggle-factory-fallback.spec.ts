import { expect, test } from './fixtures/index.js';
import { bootstrapPreviewEncode } from './preview-encode-fixture.js';

/**
 * T15 (iii) — hardware requested, software realized, reason `factory-missing`.
 *
 * The board publishes the capability and the operator asked for hardware, but
 * the encoder plugin is not in this image, so the engine built `x264enc` instead
 * and said why. The control must say the same thing: an operator who left the
 * toggle ON and silently got software has been lied to by omission, and would
 * spend the session believing the board is encoding on the VPU.
 *
 * PLAYBOOK.md:39-51 — functional spec, no screenshots, no fixed delays.
 */

const FACTORY_MISSING = {
	selected_element: 'mpph264enc',
	realized_element: 'x264enc',
	mode: 'software',
	fallback_reason: { code: 'factory-missing' },
} as const;

test.describe('preview hardware encode — factory-missing fallback', () => {
	test('the warning renders, keyed on the tagged union code', async ({ page }) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: { ...FACTORY_MISSING },
		});

		const band = page.getByTestId('preview-encode-fallback');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-code', 'factory-missing');
		await expect(page.getByTestId('preview-encode-fallback-message')).toContainText(
			"isn't installed",
		);
	});

	test('the toggle stays ON while the active line reports the SOFTWARE element', async ({
		page,
	}) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: { ...FACTORY_MISSING },
		});

		// Requested and realized are shown as the two different facts they are: the
		// request is still hardware (it persists, and the next start retries it),
		// while the running session is honestly labelled software.
		await expect(page.getByTestId('preview-encode-switch')).toHaveAttribute('aria-checked', 'true');
		const active = page.getByTestId('preview-encode-active');
		await expect(active).toHaveAttribute('data-mode', 'software');
		await expect(active).toContainText('x264enc');
	});

	test('factory-missing names no property — there is no empty slot for one', async ({ page }) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: { ...FACTORY_MISSING },
		});

		await expect(page.getByTestId('preview-encode-fallback-property')).toHaveCount(0);
	});
});
