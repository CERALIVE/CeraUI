import { encoderLoadSchema } from '@ceraui/rpc/schemas';
import { mockIslandLoadAt } from '../../src/lib/streaming/encoder-load-island-mock';
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

test('media detail follows the wire, then degrades to the legacy clock reading', async ({ page, pageRpc }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	const snapshot = encoderLoadSchema.parse(mockIslandLoadAt(Date.now()));
	await pageRpc.call(['dev', 'emit'], { type: 'encoder-load', payload: snapshot });
	const hint = page.getByTestId('media-load-hint');
	await expect(hint).toHaveAttribute('data-core-count', '8');
	await expect(hint).not.toContainText('4242');
	const trigger = hint.getByRole('button', { name: 'Media details', exact: true });
	await trigger.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Media load', exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('media-load-detail').focus();
	await expect(dialog.getByTestId('media-load-detail')).toBeFocused();
	await expect(dialog.getByTestId('media-detail-core')).toHaveCount(8);
	await expect(dialog).toContainText('145.53%');
	await expect(dialog).toContainText('121.08%');
	await expect(dialog).toContainText('PID 4242 · index 7');
	await expect(dialog).toContainText('PID 4242 · index 9');
	await expect(dialog.locator('[data-block="rga"]')).toContainText('Not published by this driver');
	await expect(dialog.locator('[data-core="fdc40100.video-codec"]')).toContainText('Unknown');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await expect(dialog).toBeVisible();
	await pageRpc.call(['dev', 'emit'], { type: 'encoder-load', payload: encoderLoadSchema.parse({
		source: 'clk-enable-count', updatedAt: Date.now(), simulated: false,
		cores: [{ core: 'rkvenc0', kind: 'active', active: true }, { core: 'rkvenc1', kind: 'unavailable' }],
	}) });
	await expect(dialog.getByTestId('media-detail-core')).toHaveCount(0);
	await expect(dialog).not.toContainText('4242');
	await expect(dialog.getByTestId('encoder-core-value-rkvenc0')).toHaveText('Busy');
	await expect(dialog.getByTestId('encoder-core-value-rkvenc0')).not.toContainText(/\d|%/);
	await expect(dialog.getByTestId('encoder-core-value-rkvenc1')).toHaveText('Unavailable');
	await expect(dialog).toContainText('Utilization and session ownership are unknown');
	expect(errors).toEqual([]);
});

/**
 * The layout gate, asserted on RENDERED GEOMETRY rather than on class names — the
 * regression it guards is a CSS one, and a class assertion walks straight through
 * it (the `expectCoresStackVertically` precedent in device-telemetry-v2).
 *
 * PR #328 shipped this widget with `@container` on its ROOT. `container-type:
 * inline-size` applies inline-size CONTAINMENT, so the whole widget reported ZERO
 * intrinsic width and every content-sized parent starved it. In the Live cockpit's
 * `flex-wrap` telemetry strip the cell collapsed to the 58px of its own "ENCODER"
 * caption; the container query then measured that 58px and drew 19px columns, in
 * which `Utilization` bled across `Load` and `87.75%` broke into `87`/`.7`/`5%`
 * down four lines. Fixture QA never saw it because the island fixture is reachable
 * from Settings and Device Health, where a grid track hands the widget a real
 * width — and the one spec that did reach the strip pushed a LEGACY (block-less)
 * reading, so `MediaLoadHint` never rendered there at all.
 *
 * Three invariants, at both breakpoints:
 *  1. the widget is not starved — its box is a real fraction of its parent's;
 *  2. no column header's ink exceeds its own cell (overlap is what garbles them);
 *  3. every reading occupies exactly one line (wrapping is what fragments them).
 */
for (const [label, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['mobile', { width: 375, height: 812 }],
] as const) {
	test(`media load stays legible at every mount — ${label}`, async ({ page, pageRpc }) => {
		await page.setViewportSize(viewport);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'settings');
		await pageRpc.call(['dev', 'emit'], {
			type: 'encoder-load',
			payload: encoderLoadSchema.parse(mockIslandLoadAt(Date.now())),
		});
		await expect(page.getByTestId('media-load-hint')).toBeVisible();

		const geometry = await page.getByTestId('media-load-hint').evaluate((root) => {
			const heads = [...root.querySelectorAll('thead th')].map((th) => ({
				text: th.textContent?.trim() ?? '',
				box: th.clientWidth,
				ink: th.scrollWidth,
			}));
			const readings = [...root.querySelectorAll('td[data-metric]')].map((td) => {
				const rect = td.getBoundingClientRect();
				const lineHeight = Number.parseFloat(getComputedStyle(td).lineHeight) || 16;
				return {
					text: td.textContent?.trim() ?? '',
					lines: Math.max(1, Math.round(rect.height / lineHeight)),
				};
			});
			return {
				width: root.getBoundingClientRect().width,
				parentWidth: root.parentElement?.getBoundingClientRect().width ?? 0,
				heads,
				readings,
			};
		});

		expect(geometry.readings.length, 'fixture rendered no readings to measure').toBeGreaterThan(0);
		expect(
			geometry.width,
			'the widget was starved by its parent — inline-size containment must not sit on its root',
		).toBeGreaterThan(geometry.parentWidth * 0.5);
		for (const head of geometry.heads) {
			expect(
				head.ink,
				`column header ${JSON.stringify(head.text)} overflows its cell and overlaps its neighbour`,
			).toBeLessThanOrEqual(head.box + 1);
		}
		for (const reading of geometry.readings) {
			expect(
				reading.lines,
				`reading ${JSON.stringify(reading.text)} wrapped across ${reading.lines} lines`,
			).toBe(1);
		}
	});
}
