import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/index.js';
import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * Raw logs filter bar in touch layouts: every translated label is painted inside
 * its own control, and every Level and Order segment is a 44 x 44 px target.
 *
 * A label can be wider than an equal share of the Level control (French
 * "Avertissements" at 320 px), and a two-character label can make every segment
 * narrower than a fingertip (Korean at 1024 px). Control rectangles stay inside
 * the viewport in both cases and axe stays silent, so this measures the PAINTED
 * text: each text run of each filter-bar control must lie inside that control's
 * content box, and the points at both ends of the run must hit the control itself
 * (not the next segment drawn over it). Each segment must be at least 44 x 44 px,
 * each segmented group must stay inside the bar, neighbouring controls and wrapped
 * rows of the bar keep their 8 px gap, and nothing scrolls sideways.
 * Ten locales at the kiosk and phone sizes; one page per case.
 */

const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;
const SIZES = [
	{ width: 320, height: 812 },
	{ width: 375, height: 812 },
	{ width: 800, height: 480 },
	{ width: 1024, height: 600 },
] as const;

for (const size of SIZES) {
	for (const locale of LOCALES) {
		test(`${locale} at ${size.width} px: every Raw logs filter label fits its own 44 px control`, async ({
			page,
		}, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'the viewport is set here, so one project is enough');
			await page.setViewportSize(size);
			await page.addInitScript((code) => {
				localStorage.setItem('locale', JSON.stringify({ code }));
			}, locale);
			await page.goto('/?mode=touch');
			await ensureAuthenticated(page);
			await navigateTo(page, 'settings');
			await page.getByTestId('settings-entry-logs').click();
			await page.getByTestId('system-logs-view').getByRole('tab').nth(1).click();
			const bar = page.getByTestId('raw-filters');
			await expect(bar).toBeVisible();
			await page.getByTestId('raw-filters-toggle').click();
			await expect(page.getByTestId('raw-order')).toBeVisible();
			// Fonts and the dialog's entry animation change geometry; measure after both settle.
			await page.evaluate(async () => {
				await document.fonts.ready;
				const finite = document
					.getAnimations()
					.filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
				await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
			});
			const result = await bar.evaluate((root) => {
				const px = (value: string) => Number.parseFloat(value) || 0;
				const found: string[] = [];
				const controls: { name: string; text: string; run: number[]; content: number[] }[] = [];
				const segments: { name: string; width: number; height: number }[] = [];
				const rootBox = root.getBoundingClientRect();
				for (const group of root.querySelectorAll<HTMLElement>('[role="radiogroup"]')) {
					const box = group.getBoundingClientRect();
					if (box.left < rootBox.left - 0.5 || box.right > rootBox.right + 0.5 || group.scrollWidth > group.clientWidth + 1)
						found.push(`${group.dataset.testid}: group ${box.left.toFixed(1)}-${box.right.toFixed(1)} leaves the bar`);
				}
				for (const control of root.querySelectorAll<HTMLElement>('button')) {
					if (!control.checkVisibility()) continue;
					const style = getComputedStyle(control);
					const box = control.getBoundingClientRect();
					const start = box.left + px(style.borderLeftWidth) + px(style.paddingLeft);
					const end = box.right - px(style.borderRightWidth) - px(style.paddingRight);
					const name =
						control.dataset.testid ??
						`${control.closest<HTMLElement>('[role="radiogroup"]')?.dataset.testid}:${control.dataset.value}`;
					if (control.getAttribute('role') === 'radio') {
						segments.push({ name, width: box.width, height: box.height });
						if (box.width < 43.5 || box.height < 43.5)
							found.push(`${name}: target ${box.width.toFixed(2)} x ${box.height.toFixed(2)} px, under 44 x 44`);
					}
					const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
					for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
						const text = node.textContent?.trim() ?? '';
						if (text === '') continue;
						const range = document.createRange();
						range.selectNodeContents(node);
						for (const run of range.getClientRects()) {
							controls.push({ name, text, run: [run.left, run.right], content: [start, end] });
							const middle = run.top + run.height / 2;
							const covered = [run.left + 1, run.right - 1].some(
								(x) => !control.contains(document.elementFromPoint(x, middle)),
							);
							if (run.left < start - 0.5 || run.right > end + 0.5 || covered)
								found.push(
									`${name} "${text}": text ${run.left.toFixed(1)}-${run.right.toFixed(1)}, content ${start.toFixed(1)}-${end.toFixed(1)}${covered ? ', covered' : ''}`,
								);
						}
					}
				}
				// The bar's own row: group its visible children into wrapped lines, then measure
				// between neighbours on a line and between lines (a shorter control is centred,
				// so a line's edge is its tallest item, not each item).
				const row = root.firstElementChild as HTMLElement;
				const items = [...row.children]
					.filter((child) => child.checkVisibility())
					.map((child) => ({ name: (child as HTMLElement).dataset.testid ?? child.tagName, box: child.getBoundingClientRect() }))
					.sort((a, b) => a.box.top - b.box.top);
				const lines: { top: number; bottom: number; items: typeof items }[] = [];
				for (const item of items) {
					const line = lines.at(-1);
					if (line && item.box.top < line.bottom && item.box.bottom > line.top) {
						line.items.push(item);
						line.bottom = Math.max(line.bottom, item.box.bottom);
					} else lines.push({ top: item.box.top, bottom: item.box.bottom, items: [item] });
				}
				const gaps: number[] = [];
				lines.forEach((line, i) => {
					const across = [...line.items].sort((a, b) => a.box.left - b.box.left);
					for (const [j, item] of across.entries()) {
						const before = across[j - 1];
						if (before === undefined) continue;
						const gap = item.box.left - before.box.right;
						gaps.push(gap);
						if (Math.abs(gap - 8) > 0.5) found.push(`${before.name} | ${item.name}: gap ${gap.toFixed(1)} px, not 8`);
					}
					const next = lines[i + 1];
					if (next) {
						const gap = Math.min(...next.items.map((item) => item.box.top)) - line.bottom;
						gaps.push(gap);
						if (Math.abs(gap - 8) > 0.5) found.push(`row ${i + 1} | row ${i + 2}: gap ${gap.toFixed(1)} px, not 8`);
					}
				});
				const doc = document.documentElement;
				if (doc.scrollWidth > doc.clientWidth) found.push(`page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth}`);
				return { found, segments, gaps, controls };
			});
			fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
			fs.writeFileSync(
				path.join(EVIDENCE_DIR, `raw-logs-labels-${locale}-${size.width}.json`),
				`${JSON.stringify(result, null, 1)}\n`,
				'utf8',
			);
			expect(result.found).toEqual([]);
		});
	}
}
