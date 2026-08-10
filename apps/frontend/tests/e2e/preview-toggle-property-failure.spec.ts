import { expect, test } from './fixtures/index.js';
import { bootstrapPreviewEncode } from './preview-encode-fixture.js';

/**
 * T15 (iv) — hardware requested, software realized, reason `property-failure`.
 *
 * This spec exists for one assertion the schema tests structurally cannot make:
 * that the SVELTE layer carries `property` through to the screen. Zod proves the
 * field survives the wire; only a rendered DOM proves the template did not drop
 * it. And the property name is the entire difference between "hardware preview
 * is broken" and "this image's encoder plugin does not take `bps`" — the second
 * is actionable, the first sends an operator to reflash a board for nothing.
 *
 * PLAYBOOK.md:39-51 — functional spec, no screenshots, no fixed delays.
 */

const PROPERTY_FAILURE = {
	selected_element: 'mpph264enc',
	realized_element: 'x264enc',
	mode: 'software',
	fallback_reason: { code: 'property-failure', property: 'bps' },
} as const;

test.describe('preview hardware encode — property-failure fallback', () => {
	test('the warning shows BOTH the code-specific message and the property name', async ({
		page,
	}) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: { ...PROPERTY_FAILURE },
		});

		const band = page.getByTestId('preview-encode-fallback');
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute('data-code', 'property-failure');

		await expect(page.getByTestId('preview-encode-fallback-message')).toContainText(
			'rejected a setting',
		);
		await expect(page.getByTestId('preview-encode-fallback-property')).toHaveText('bps');
	});

	test('the property is the one the engine named, not a hardcoded string', async ({ page }) => {
		// A template that printed a constant would pass the assertion above. Driving
		// a different property through the same path is what proves it is wired.
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: {
				...PROPERTY_FAILURE,
				fallback_reason: { code: 'property-failure', property: 'rc-mode' },
			},
		});

		await expect(page.getByTestId('preview-encode-fallback-property')).toHaveText('rc-mode');
	});

	test('the active line reports the software element the engine actually built', async ({
		page,
	}) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: { ...PROPERTY_FAILURE },
		});

		const active = page.getByTestId('preview-encode-active');
		await expect(active).toHaveAttribute('data-mode', 'software');
		await expect(active).toContainText('x264enc');
		await expect(page.getByTestId('preview-encode-switch')).toHaveAttribute('aria-checked', 'true');
	});
});
