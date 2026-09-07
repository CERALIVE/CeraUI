import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import type { UpdateState } from '@ceraui/rpc/schemas';

import { expect, type PageRpc, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo } from '../helpers/index.js';
import { SettingsPage } from '../pages/settings.js';

test.describe('@visual Settings destination snapshots', () => {
	test('@visual settings destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const settings = new SettingsPage(page);
		await settings.open();
		await expect(page).toHaveScreenshot('settings-desktop.png', {
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});

/**
 * design-pass-27 — the update surfaces after the calm-register / honest-layers pass.
 *
 * TWO surfaces, one operator concern:
 *
 *  1. `updating-overlay.svelte` is the full-screen takeover a device shows while
 *     apt runs. It led with gradient-clipped text and two `animate-bounce`
 *     glyphs — both flagged by the design detector, and the gradient is a named
 *     anti-reference in `.impeccable.md`. It is now a calm STATIC status
 *     register, which also means the e-ink freeze (`app.css` `[data-display]`)
 *     stills it, because nothing here is JS-driven.
 *
 *  2. `UpdatesDialog.svelte` printed `failed.reason` verbatim (an apt stderr
 *     line an operator with no console cannot act on), showed every discovered
 *     package as one undifferentiated list, and offered Install whenever
 *     `package_count > 0` — including for a platform-layer or kept-back set the
 *     device positively refuses to install. It now maps a known reason to keyed
 *     copy, files platform/kept-back entries into ONE quiet band with NO action
 *     control, and states the reachability verdict as one muted line.
 *
 * Three viewports, matching the C4 capture convention: 1280×900 desktop,
 * 1024×600 in `?mode=touch` applied at NAVIGATION (the modem-ux precedent — a
 * `data-layout-mode` set after load measures the pre-lift geometry), and 375×812
 * mobile. Evidence PNGs land in the gitignored `test-results/design-pass/27/`
 * (Rule D: repo-local, never above the checkout root); they are evidence, never
 * the check — every criterion below is asserted.
 */

const DESIGN_PASS_DIR = path.resolve(
	import.meta.dirname,
	'../../../test-results/design-pass/27',
);

type Condition = {
	readonly name: string;
	readonly project: 'desktop' | 'mobile';
	readonly viewport: { width: number; height: number };
	readonly touch: boolean;
};

// Desktop project owns the 1280×900 and the 1024×600 touch/kiosk cases; the
// mobile project owns 375×812. Each condition self-skips in the other project so
// every PNG is produced exactly once (the design-pass-24 precedent).
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

/**
 * A discovery that mixes all three classes: one installable app package, one
 * platform-layer package that ships with the next OS image, and one app package
 * apt held back. Only the first is actionable, so `actionable_count` is 1 — and
 * that count, never `package_count`, is what may render an Install control.
 */
const MIXED: UpdateState = {
	kind: 'available',
	identity: {
		version: 'design-pass-27',
		packages: ['cerastream', 'gstreamer1.0-rockchip-ceralive', 'ceralive-device'],
	},
	package_count: 3,
	download_size: '18.4 MB',
	checked_at: 1_700_000_000_000,
	packages: [
		{ name: 'cerastream', layer: 'app', actionable: true },
		{
			name: 'gstreamer1.0-rockchip-ceralive',
			layer: 'platform',
			actionable: false,
		},
		{ name: 'ceralive-device', layer: 'app', kept_back: true, actionable: false },
	],
	actionable_count: 1,
	reachability: { ipv4: 'ok', ipv6: 'no_route', used: 'ipv4' },
};

function emitStatus(pageRpc: PageRpc, payload: unknown): Promise<unknown> {
	return pageRpc.call(['dev', 'emit'], { type: 'status', payload });
}

/**
 * The overlay is a vaul Drawer, so it slides in on a CSS transition. Screenshot
 * it before that settles and the PNG shows a half-open sheet with its own title
 * clipped by the viewport — evidence of nothing. Infinite animations are excluded
 * or a skeleton pulse would hang this forever.
 */
async function settleMotion(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation.effect?.getComputedTiming().iterations !==
						Number.POSITIVE_INFINITY,
				)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
}

for (const condition of CONDITIONS) {
	test.describe(`@visual design-pass-27 — update surfaces (${condition.name})`, () => {
		test.beforeEach(async ({ page, pageRpc }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);
			// Requested here (before `page.goto`) so its WebSocket route is installed
			// before app boot — PLAYBOOK.md, "Request `pageRpc` in a `beforeEach`".
			void pageRpc;

			await page.setViewportSize(condition.viewport);
			// Touch layout is applied at NAVIGATION, never afterwards: `app.css`'s
			// `[data-layout-mode='touch']` lift changes hit areas and paddings, so a
			// flag flipped after load measures the pre-lift geometry.
			await page.goto(condition.touch ? '/?mode=touch' : '/');
			await ensureAuthenticated(page);
			await navigateTo(page, 'settings');
			fs.mkdirSync(DESIGN_PASS_DIR, { recursive: true });
		});

		test(
			'the Updates dialog files platform and kept-back packages in a quiet band with no action',
			{ tag: '@visual' },
			async ({ page, pageRpc }) => {
				const settings = new SettingsPage(page);
				await settings.openUpdates();
				await emitStatus(pageRpc, { update_state: MIXED });

				const dialog = page.getByRole('dialog', { name: 'Software Updates' });
				await expect(dialog.getByTestId('update-summary')).toBeVisible();
				// The version line proves the injected state reached the dialog before
				// anything below is measured.
				await expect(dialog.getByTestId('update-version')).toContainText(
					'design-pass-27',
				);

				// Capture BEFORE asserting: the PNG is evidence for whichever tree this
				// runs against, including the pre-change one where the assertions below
				// are RED. A screenshot taken after a failed assertion never exists.
				await dialog.screenshot({
					path: path.join(DESIGN_PASS_DIR, `updates-dialog-${condition.name}.png`),
				});

				// The quiet band exists, names both non-installable entries, and holds
				// NO action control — "ships with the next OS image" is a statement, not
				// an offer.
				const band = dialog.getByTestId('update-platform-band');
				await expect(band).toBeVisible();
				await expect(band).toContainText('gstreamer1.0-rockchip-ceralive');
				await expect(band).toContainText('ceralive-device');
				expect(await band.locator('button, a[href], input, select').count()).toBe(0);

				// The reachability verdict is ONE muted line, and it says which family
				// answered rather than leaving the operator to infer it.
				await expect(dialog.getByTestId('update-reachability')).toContainText(
					'IPv4',
				);

				// Install is gated on the ACTIONABLE count, so the single app package is
				// offered and the two the device refuses are not counted into it.
				await expect(dialog.getByTestId('update-install')).toBeVisible();
			},
		);

		test(
			'the updating overlay is a calm status register, not a gradient with a bounce',
			{ tag: '@visual' },
			async ({ page, pageRpc }) => {
				// A mid-flight progress frame: `result` is absent, so this is neither of
				// the two terminal states and no completion toast fires.
				await emitStatus(pageRpc, {
					updating: { downloading: 2, unpacking: 0, setting_up: 0, total: 6 },
				});

				const overlay = page.getByTestId('updating-overlay');
				await expect(overlay).toBeVisible({ timeout: 20_000 });
				await settleMotion(page);

				// Settled, not mid-slide, and the phase an operator came here to read is
				// WHOLLY on screen. A half-open sheet clips its own title, and a PNG of
				// that measures the transition rather than the design.
				await expect(overlay.getByTestId('update-phase')).toBeInViewport({
					ratio: 1,
				});

				await page.screenshot({
					path: path.join(
						DESIGN_PASS_DIR,
						`updating-overlay-${condition.name}.png`,
					),
				});

				// The two detector findings, measured on the RENDERED tree rather than
				// by grepping the component: a class rename that keeps the effect would
				// walk straight through a source grep.
				const slop = await overlay.evaluate((root) => {
					const nodes = [root, ...root.querySelectorAll('*')];
					return {
						bouncing: nodes.filter((el) =>
							(el.getAttribute('class') ?? '').includes('animate-bounce'),
						).length,
						gradientText: nodes.filter((el) => {
							const style = getComputedStyle(el);
							return (
								style.getPropertyValue('-webkit-background-clip') === 'text' ||
								style.getPropertyValue('background-clip') === 'text'
							);
						}).length,
					};
				});
				expect(slop, 'the overlay carries no bounce and no gradient text').toEqual({
					bouncing: 0,
					gradientText: 0,
				});

				// …and the phase register still NAMES the phase it is in. Calming the
				// treatment must not cost the word.
				await expect(overlay.getByTestId('update-phase')).toContainText(
					'Downloading',
				);
			},
		);
	});
}
