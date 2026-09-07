import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';
import { probeContainment } from '../helpers/modem-containment.js';
import { LivePage } from '../pages/live.js';

test.describe('@visual Live destination snapshots', () => {
	test('@visual live destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const live = new LivePage(page);
		await live.open();
		await expect(page).toHaveScreenshot('live-desktop.png', {
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});

/**
 * design-pass-24 — the Live IDLE path after the quieter-header / one-rhythm pass.
 *
 * The critique scored the idle Live destination 25/40 on DENSITY and competing
 * layers: `SourceSection`'s header row carried a section title on the left and a
 * six-element capability cluster on the right, with a second full-width bordered
 * box directly beneath it — two horizontal layers competing before the operator
 * reached the source list at all.
 *
 * The refinement is REFINE/DISTILL only: the header keeps ONE state signal, the
 * selected-source line moves under it, and the capability cluster is DEMOTED
 * into the panel it describes. Nothing is deleted — every state word and every
 * `data-testid` survives the move, which is exactly what this spec measures.
 *
 * Three viewports, matching the C4 capture convention: 1280×900 desktop,
 * 1024×600 in `?mode=touch` applied at NAVIGATION (the modem-ux precedent — a
 * `data-layout-mode` set after load measures the pre-lift geometry), and 375×812
 * mobile. Evidence PNGs land in the gitignored `test-results/design-pass/24/`
 * (Rule D: repo-local, never above the checkout root); they are evidence, never
 * the check — every criterion below is asserted.
 */

const DESIGN_PASS_DIR = path.resolve(
	import.meta.dirname,
	'../../../test-results/design-pass/24',
);

/**
 * Every `data-testid` on the idle Live path that an existing spec asserts.
 *
 * Measured from the pre-change tree (the `before` run of this same spec, whose
 * inventory dump is the evidence), so this list is an OBSERVED inventory rather
 * than a hand-typed wish list. A refinement that moves a badge must not cost one
 * of these — "demote into the row it describes, never delete" is the whole rule,
 * and this is its mechanism.
 */
const REQUIRED_TESTIDS: readonly string[] = [
	// IdleCockpit composition (the four blocks, in order)
	'idle-cockpit',
	'source-section',
	'preview-disclosure',
	'stream-setup-chain',
	'live-roadmap',
	// SourceSection — header, selected-source line, capability cluster
	'source-capabilities',
	'cap-device-max',
	'source-active-config',
	'active-config-value',
	'source-list',
	'source-audio',
	// The two edit affordances the idle path owns
	'open-encoder-dialog',
	'open-audio-dialog',
];

type Condition = {
	readonly name: string;
	readonly project: 'desktop' | 'mobile';
	readonly viewport: { width: number; height: number };
	readonly touch: boolean;
};

// Desktop project owns the 1280×900 and the 1024×600 touch/kiosk cases; the
// mobile project owns 375×812. Each condition self-skips in the other project so
// every PNG is produced exactly once (the source-overhaul precedent).
const CONDITIONS: readonly Condition[] = [
	{
		name: 'desktop-1280x900',
		project: 'desktop',
		viewport: { width: 1280, height: 900 },
		touch: false,
	},
	{
		name: 'touch-1024x600',
		project: 'desktop',
		viewport: { width: 1024, height: 600 },
		touch: true,
	},
	{
		name: 'mobile-375x812',
		project: 'mobile',
		viewport: { width: 375, height: 812 },
		touch: false,
	},
];

type IdleGeometry = {
	readonly blocks: readonly string[];
	readonly gaps: readonly number[];
	readonly openDetails: readonly string[];
	readonly testIds: readonly string[];
};

for (const condition of CONDITIONS) {
	test.describe(`@visual design-pass-24 — Live idle path (${condition.name})`, () => {
		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);

			await page.setViewportSize(condition.viewport);
			// Touch layout is applied at NAVIGATION, never afterwards: `app.css`'s
			// `[data-layout-mode='touch']` lift changes hit areas and paddings, so a
			// flag flipped after load measures the pre-lift geometry.
			await page.goto(condition.touch ? '/?mode=touch' : '/');
			await ensureAuthenticated(page);
			await navigateTo(page, 'live');
			await expect(page.getByTestId('idle-cockpit')).toBeVisible({ timeout: 20_000 });
		});

		test(
			'the idle header is quiet, the cockpit keeps one rhythm, and nothing was deleted',
			{ tag: '@visual' },
			async ({ page }) => {
				fs.mkdirSync(DESIGN_PASS_DIR, { recursive: true });

				const cockpit = page.getByTestId('idle-cockpit');
				await cockpit.scrollIntoViewIfNeeded();

				// Capture BEFORE asserting: the PNG is evidence for whichever tree this
				// runs against, including the pre-change one where the assertions below
				// are RED. A screenshot taken after a failed assertion never exists.
				await cockpit.screenshot({
					path: path.join(DESIGN_PASS_DIR, `live-idle-${condition.name}.png`),
				});

				const geometry = await page.evaluate<IdleGeometry>(() => {
					const root = document.querySelector('[data-testid="idle-cockpit"]');
					if (root === null) throw new Error('idle-cockpit is not mounted');

					const laidOut = [...root.children].filter(
						(el) => el.getBoundingClientRect().height > 0,
					);
					const describe = (el: Element): string =>
						el.getAttribute('data-testid') ?? el.tagName.toLowerCase();

					const gaps: number[] = [];
					for (let i = 1; i < laidOut.length; i += 1) {
						const previous = laidOut[i - 1]?.getBoundingClientRect();
						const current = laidOut[i]?.getBoundingClientRect();
						if (previous === undefined || current === undefined) continue;
						gaps.push(Math.round(current.top - previous.bottom));
					}

					return {
						blocks: laidOut.map(describe),
						gaps,
						openDetails: [...document.querySelectorAll('details[open]')].map(describe),
						testIds: [
							...new Set(
								[...document.querySelectorAll('[data-testid]')].map(
									(el) => el.getAttribute('data-testid') ?? '',
								),
							),
						].sort(),
					};
				});

				fs.writeFileSync(
					path.join(DESIGN_PASS_DIR, `inventory-${condition.name}.json`),
					`${JSON.stringify(geometry, null, 2)}\n`,
					'utf8',
				);

				// ── 1. Every previously asserted testid still exists ─────────────────
				const missing = REQUIRED_TESTIDS.filter((id) => !geometry.testIds.includes(id));
				expect(
					missing,
					`${condition.name}: the refinement deleted testid(s) instead of demoting them: ${missing.join(', ')}`,
				).toEqual([]);

				// ── 2. No horizontal overflow at this viewport (BP-1) ────────────────
				// `documentOverflowPx` is the contract, exactly as `expectContained`
				// applies it; `overflowSources` is the diagnostic that names the
				// culprit and is deliberately NOT asserted on its own. It reports any
				// box wider than the viewport even when a `overflow-hidden` ancestor
				// clips it — at 375px the HUD dock's bond-constellation chips do
				// exactly that, which is a clipping question owned by `HudBar`, not a
				// horizontal-scroll defect on the idle path.
				const containment = await probeContainment(page);
				expect(
					containment.documentOverflowPx,
					`${condition.name}: the document overflows horizontally by ${containment.documentOverflowPx}px. Widest offenders:\n${containment.overflowSources.join('\n')}`,
				).toBeLessThanOrEqual(1);

				// ── 3. The header's badge budget (the CellularSection precedent) ─────
				// A header is undone by ten good commits, each adding the one pill its
				// own feature obviously needed — which is how the cluster this pass
				// removed was built. Two is the ceiling.
				const header = page.getByTestId('source-header');
				await expect(
					header,
					`${condition.name}: the source header must be identifiable for the badge budget`,
				).toHaveCount(1);
				expect(
					await header.locator('[data-status-badge]').count(),
					`${condition.name}: the source header exceeded its two-badge budget`,
				).toBeLessThanOrEqual(2);

				// ── 4. …and the capability cluster is DEMOTED out of it, not deleted ─
				expect(
					await header.getByTestId('source-capabilities').count(),
					`${condition.name}: the capability cluster is back in the header — it belongs in the selected-source panel it describes`,
				).toBe(0);
				await expect(
					page.getByTestId('source-active-config').getByTestId('source-capabilities'),
					`${condition.name}: the capability cluster must live in the panel it describes`,
				).toHaveCount(1);
				// The state WORD moved with it, and "SOURCE MAX" is still readable.
				await expect(page.getByTestId('cap-device-max')).toBeVisible();

				// ── 5. One vertical rhythm across the four IdleCockpit blocks ────────
				expect(
					geometry.blocks,
					`${condition.name}: the idle cockpit must lay out its four blocks`,
				).toEqual([
					'source-section',
					'preview-disclosure',
					'stream-setup-chain',
					'live-roadmap',
				]);
				expect(
					[...new Set(geometry.gaps)],
					`${condition.name}: the four blocks must share ONE gap rhythm, measured ${geometry.gaps.join(' / ')}px`,
				).toHaveLength(1);

				// ── 6. Both disclosures stay collapsed by default ────────────────────
				expect(
					geometry.openDetails,
					`${condition.name}: a disclosure opened itself: ${geometry.openDetails.join(', ')}`,
				).toEqual([]);
			},
		);
	});
}
