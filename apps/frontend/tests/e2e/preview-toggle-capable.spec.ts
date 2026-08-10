import { expect, test } from './fixtures/index.js';
import { bootstrapPreviewEncode } from './preview-encode-fixture.js';

/**
 * T15 (i) — a board that publishes `preview_hw_capability: true`.
 *
 * The control is offered, starts OFF, and switching it on dispatches T18's
 * `streaming.setConfig({ previewEncode: "hardware" })` — the persisted request,
 * which is the only channel where "hardware" is ever a REQUEST rather than a
 * report. The active line then follows the engine's REALIZED status, never the
 * request: keeping those two apart is the whole point of the control.
 *
 * PLAYBOOK.md:39-51 — functional spec, no screenshots, no fixed delays.
 */

test.describe('preview hardware encode — capable board', () => {
	test('the control is offered, starts OFF, and says when the choice lands', async ({ page }) => {
		await bootstrapPreviewEncode(page, { capability: true });

		const control = page.getByTestId('preview-encode-control');
		await expect(control).toBeVisible();

		const toggle = page.getByTestId('preview-encode-switch');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');

		// The engine fixes the preview encoder when it builds the session graph, so
		// the choice cannot take effect on a running stream and must not pretend to.
		await expect(control.getByTestId('preview-encode-helper')).toContainText('next stream');
	});

	test('switching it on dispatches setConfig({previewEncode:"hardware"})', async ({ page }) => {
		const harness = await bootstrapPreviewEncode(page, { capability: true });

		const toggle = page.getByTestId('preview-encode-switch');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');

		expect(harness.setConfigCalls).toHaveLength(1);
		expect(harness.setConfigCalls[0]?.path).toEqual(['streaming', 'setConfig']);
		expect(harness.setConfigCalls[0]?.input).toMatchObject({ previewEncode: 'hardware' });
	});

	test('a persisted request is never rendered as an active encoder', async ({ page }) => {
		await bootstrapPreviewEncode(page, { capability: true });
		const active = page.getByTestId('preview-encode-active');

		// Nothing realized → the control says so. Absent is NOT "software".
		await expect(active).toHaveAttribute('data-mode', 'none');

		await page.getByTestId('preview-encode-switch').click();
		await expect(page.getByTestId('preview-encode-switch')).toHaveAttribute('aria-checked', 'true');

		await expect(active).toHaveAttribute('data-mode', 'none');
		await expect(page.getByTestId('preview-encode-fallback')).toHaveCount(0);
	});

	test('a delivered hardware session names its element on the active line', async ({ page }) => {
		await bootstrapPreviewEncode(page, {
			capability: true,
			persistedRequest: 'hardware',
			realized: {
				selected_element: 'mpph264enc',
				realized_element: 'mpph264enc',
				mode: 'hardware',
			},
		});

		const active = page.getByTestId('preview-encode-active');
		await expect(active).toHaveAttribute('data-mode', 'hardware');
		await expect(active).toContainText('mpph264enc');
		await expect(page.getByTestId('preview-encode-switch')).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('preview-encode-fallback')).toHaveCount(0);
	});
});
