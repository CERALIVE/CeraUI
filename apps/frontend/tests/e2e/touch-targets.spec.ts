import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { KIOSK_VIEWPORT } from './helpers/modem-containment.js';

/**
 * App-shell touch targets and motion, @a11y. Sibling of `modem-a11y.spec.ts`,
 * which owns the same two contracts for the MODEM surfaces; this file owns the
 * three shell controls no destination gate reaches — the auth password reveal,
 * a dialog header's close button, and the update banner's dismiss.
 *
 * TWO measured properties, both PASS/FAIL with no human-judgment step:
 *
 *  1. HIT AREA, on both axes, at 1024x600 in `?mode=touch`. All three controls
 *     are SQUARE icon buttons (36 / 32 / 24px), so `app.css`'s `min-height` lift
 *     could only ever have fixed their height — the width stayed short on every
 *     one of them, and the banner's dismiss carries no `data-slot` so the lift
 *     never reached it at all. They now opt into the `::after` hit-area overlay
 *     (`data-touch-target="hit-area"`), which is why this leg measures the
 *     overlay's resolved insets rather than `getBoundingClientRect()` — the
 *     switch precedent in `modem-a11y.spec.ts` leg 4, generalised to two axes.
 *
 *     The PAINTED box is asserted to stay SMALL in the same breath. Asserting
 *     both bounds is what stops the tempting one-line "fix" of adding these to
 *     the `min-height` list: a ghost icon button grown to 32x44 is a hover pill
 *     that no longer matches the glyph inside it, and the dialog's close button
 *     would additionally reach 6px past a 52px header into the scrollable body
 *     and own the first pixels of a scroll gesture. That last one is asserted
 *     directly: the overlay's bottom edge may not cross the header's.
 *
 *  2. REDUCED MOTION, read from the COMPUTED style of the live tree. `app.css`
 *     already collapses every animation to `0.01ms` under
 *     `prefers-reduced-motion: reduce`, so a duration sweep alone is VACUOUS
 *     here — it was green before these components carried `motion-safe:` and it
 *     is green after. The falsifiable property is `animation-name`: a
 *     `motion-safe:` utility declares no animation at all under reduce, where a
 *     bare `animate-*` still names one. Both legs flip the emulation and assert
 *     the animation comes back, so neither can pass on a tree that simply never
 *     rendered the node.
 *
 * KNOWN GAP, recorded rather than papered over: `NavigationRenderer`'s
 * transition spinner is gated on `isNavigationTransitioning`, and
 * `setTransitioning` has NO caller in shipped source — the node is unreachable
 * by construction, so no browser leg can render it. Its `motion-safe:` is
 * covered by `src/main/navigation/NavigationRenderer.test.ts`.
 *
 * CI LANE, also recorded: the Build Check "Accessibility gate" step selects
 * `a11y.spec.ts` as a PATH REGEX, which `modem-a11y.spec.ts` matches as a
 * substring and this file does not; the Functional lane meanwhile
 * `--grep-invert`s `@a11y`. This spec therefore runs in the effort's own
 * consolidation lane (`--grep "@a11y"`) and locally, but in neither Build Check
 * lane. Closing that needs a workflow-filter edit, which also moves the root
 * workspace CI manifest — out of this todo's scope.
 */

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	'../../test-results/touch-targets',
);

const TARGET_PX = 44;

interface ControlMetrics {
	readonly name: string;
	readonly boxWidth: number;
	readonly boxHeight: number;
	readonly hitWidth: number;
	readonly hitHeight: number;
	readonly overlay: { top: number; bottom: number; left: number; right: number } | null;
}

/**
 * Box geometry plus the `::after` hit-area overlay's own extent.
 *
 * The overlay is read from the pseudo's RESOLVED insets, not probed with
 * `elementFromPoint`: two of these three controls are measured with a modal
 * dialog or a sticky banner on screen, where a hit test answers about occlusion
 * rather than about the declared target. An absolutely-positioned pseudo
 * resolves its insets against the host's PADDING box, so the overlay's extent is
 * that box minus both insets on each axis; logical insets map to physical ones
 * in the base (LTR) locale this leg runs in. A control with no overlay reports
 * `content: none`, falls through, and is measured on its box alone — which is
 * exactly the pre-fix reading this gate must be able to fail on.
 */
async function measureControl(
	page: Page,
	name: string,
	selector: string,
): Promise<ControlMetrics> {
	return page.evaluate(
		([label, sel]) => {
			const node = document.querySelector(sel as string) as HTMLElement | null;
			if (node === null) throw new Error(`no element matched ${sel}`);
			const rect = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			const after = getComputedStyle(node, '::after');
			const px = (value: string): number => {
				const parsed = Number.parseFloat(value);
				return Number.isFinite(parsed) ? parsed : Number.NaN;
			};

			let overlay: {
				top: number;
				bottom: number;
				left: number;
				right: number;
			} | null = null;
			if (after.position === 'absolute' && after.content !== 'none') {
				const top = rect.top + px(style.borderTopWidth) + px(after.insetBlockStart);
				const bottom =
					rect.bottom - px(style.borderBottomWidth) - px(after.insetBlockEnd);
				const left =
					rect.left + px(style.borderLeftWidth) + px(after.insetInlineStart);
				const right =
					rect.right - px(style.borderRightWidth) - px(after.insetInlineEnd);
				if ([top, bottom, left, right].every((n) => Number.isFinite(n))) {
					overlay = { top, bottom, left, right };
				}
			}

			return {
				name: label as string,
				boxWidth: rect.width,
				boxHeight: rect.height,
				hitWidth: Math.max(rect.width, overlay ? overlay.right - overlay.left : 0),
				hitHeight: Math.max(rect.height, overlay ? overlay.bottom - overlay.top : 0),
				overlay,
			};
		},
		[name, selector] as const,
	);
}

/** Computed animation state of the first element a selector resolves to. */
async function animationOf(
	page: Page,
	selector: string,
): Promise<{ name: string; durationMs: number }> {
	return page.evaluate((sel) => {
		const node = document.querySelector(sel);
		if (node === null) throw new Error(`no element matched ${sel}`);
		const style = getComputedStyle(node);
		const durationMs = Math.max(
			0,
			...style.animationDuration
				.split(',')
				.map((part) => part.trim())
				.map((part) =>
					part.endsWith('ms')
						? Number.parseFloat(part)
						: Number.parseFloat(part) * 1000,
				)
				.filter((n) => Number.isFinite(n)),
		);
		return { name: style.animationName, durationMs };
	}, selector);
}

/**
 * `ensureAuthenticated` does this too, but the first measurement here is on the
 * PRE-AUTH screen, before that helper runs: a cold dev server takes seconds to
 * mount, and until it does `<html>` carries no `data-layout-mode` and
 * `index.html`'s `#js-failed` overlay is on screen.
 */
async function waitForAppMount(page: Page): Promise<void> {
	await page
		.waitForFunction(
			() => (window as unknown as { __ceraAppMounted?: boolean }).__ceraAppMounted === true,
			undefined,
			{ timeout: 60_000 },
		)
		.catch(() => undefined);
	await page.evaluate(() => document.getElementById('js-failed')?.remove());
}

/**
 * Drain every FINITE animation before a geometry read.
 *
 * `getBoundingClientRect()` reports the TRANSFORMED box, and all three surfaces
 * here enter with a `zoom-in-95` — measured mid-flight, a 44px control reads
 * 42.2px and the gate fails on a product that is correct. Infinite animations
 * (the banner's own pulse, any skeleton) are excluded or this never resolves.
 */
async function settleAnimations(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const finite = document.getAnimations().filter((animation) => {
			const effect = animation.effect;
			return effect === null || effect.getTiming().iterations !== Number.POSITIVE_INFINITY;
		});
		await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
	});
}

function writeEvidence(fileName: string, body: unknown): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		`${JSON.stringify(body, null, 2)}\n`,
		'utf8',
	);
}

const UPDATE_BANNER = 'div[role="status"]:has([data-testid="update-banner-dismiss"])';

test.describe('@a11y app-shell touch targets and motion', () => {
	test('touch mode gives the three shell controls a 44px hit area without growing their box @a11y', async ({
		page,
		pageRpc,
	}) => {
		// The socket route is installed by the fixture, before this body runs, so
		// the `dev.emit` below reaches the app on the document it opened.
		void pageRpc;

		await page.setViewportSize(KIOSK_VIEWPORT);
		// `data-layout-mode` must be set BEFORE first paint: applying it afterwards
		// measures the pre-lift geometry (the modem-ux/modem-a11y precedent).
		await page.goto('/?mode=touch');
		await waitForAppMount(page);
		await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'touch', {
			timeout: 30_000,
		});

		const controls: ControlMetrics[] = [];

		// 1. The password reveal, on the pre-auth screen it lives on.
		await expect(page.getByTestId('auth-password-visibility')).toBeVisible();
		await settleAnimations(page);
		controls.push(
			await measureControl(
				page,
				'auth-password-visibility',
				'[data-testid="auth-password-visibility"]',
			),
		);

		await ensureAuthenticated(page);

		// 2. A dialog header's close button. Versions is the cheapest AppDialog on
		//    the Settings destination — read-only, so its close button is the whole
		//    interaction surface, which is precisely why it has to be reachable.
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-versions').click();
		const close = page.getByTestId('app-dialog-close');
		await expect(close).toBeVisible();
		await settleAnimations(page);
		const closeMetrics = await measureControl(
			page,
			'app-dialog-close',
			'[data-testid="app-dialog-close"]',
		);
		controls.push(closeMetrics);

		const headerBottom = await page.evaluate(() => {
			const header = document.querySelector('[data-app-dialog-header]');
			if (header === null) throw new Error('the open dialog rendered no header');
			return header.getBoundingClientRect().bottom;
		});

		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);

		// 3. The update banner's dismiss. `updating: true` (the BOOLEAN form) is
		//    what raises the banner alone: Layout mounts the full-screen updating
		//    overlay only for the OBJECT form, and that overlay would sit on top of
		//    the very control being measured.
		await pageRpc.call(['dev', 'emit'], {
			type: 'status',
			payload: { updating: true },
		});
		await expect(page.getByTestId('update-banner-dismiss')).toBeVisible();
		await settleAnimations(page);
		controls.push(
			await measureControl(
				page,
				'update-banner-dismiss',
				'[data-testid="update-banner-dismiss"]',
			),
		);

		writeEvidence('touch-targets.json', {
			generatedAt: new Date().toISOString(),
			viewport: KIOSK_VIEWPORT,
			targetPx: TARGET_PX,
			headerBottom,
			controls,
		});

		for (const control of controls) {
			expect(
				control.hitWidth,
				`${control.name} hit area is ${control.hitWidth}px wide, below the ${TARGET_PX}px target`,
			).toBeGreaterThanOrEqual(TARGET_PX - 0.5);
			expect(
				control.hitHeight,
				`${control.name} hit area is ${control.hitHeight}px tall, below the ${TARGET_PX}px target`,
			).toBeGreaterThanOrEqual(TARGET_PX - 0.5);

			// The target is carried by the OVERLAY, never by the paint. A control
			// whose box reached 44px was grown, which is the regression this pairs
			// against — the switch rule in `modem-a11y.spec.ts` leg 4, same reason.
			expect(
				Math.max(control.boxWidth, control.boxHeight),
				`${control.name} was grown to ${control.boxWidth}x${control.boxHeight}px — lift its ::after hit area, not its box`,
			).toBeLessThan(TARGET_PX - 0.5);
		}

		// The dialog's own scroll must stay the dialog's. The header is not a
		// scroll container; the body beneath it is, so an overlay crossing that
		// edge would own the first pixels of a scroll gesture started there.
		expect(closeMetrics.overlay, 'the dialog close button declared no hit area').not.toBeNull();
		expect(
			closeMetrics.overlay?.bottom ?? Number.POSITIVE_INFINITY,
			`the dialog close hit area ends at ${closeMetrics.overlay?.bottom}px, past the header's ${headerBottom}px`,
		).toBeLessThanOrEqual(headerBottom + 0.5);
	});

	test('reduced motion declares no animation on the update banner @a11y', async ({
		page,
		pageRpc,
	}) => {
		void pageRpc;

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize(KIOSK_VIEWPORT);
		await page.goto('/');
		await ensureAuthenticated(page);

		await pageRpc.call(['dev', 'emit'], {
			type: 'status',
			payload: { updating: true },
		});
		const banner = page.locator(UPDATE_BANNER);
		await expect(banner).toBeVisible();

		const iconSelector = `${UPDATE_BANNER} > svg`;
		await expect(page.locator(iconSelector)).toBeVisible();

		const stilled = await animationOf(page, iconSelector);
		expect(
			stilled.name,
			`the update banner's progress glyph still declares "${stilled.name}" under reduced motion`,
		).toBe('none');

		// Non-vacuity: the same node must animate once the preference is lifted, or
		// this leg would pass on a tree that simply never rendered an animation.
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		const moving = await animationOf(page, iconSelector);
		expect(
			moving.name,
			'the update banner glyph does not animate even without a motion preference — this leg proves nothing',
		).not.toBe('none');
		expect(moving.durationMs).toBeGreaterThan(1);

		writeEvidence('reduced-motion-banner.json', {
			generatedAt: new Date().toISOString(),
			reduce: stilled,
			noPreference: moving,
		});
	});

	test('reduced motion declares no animation on the auth-check spinner @a11y', async ({
		page,
	}, testInfo) => {
		// Desktop only: Layout sizes its auth-check timeout off the user agent, and
		// the mobile project's 1.5s window is too tight to measure inside reliably.
		test.skip(
			testInfo.project.name !== 'desktop',
			'the auth-check window is user-agent sized; measure it on desktop',
		);
		// The loading shell is reached a few seconds after mount (below), which on
		// a cold dev server can outlast the 30s default all on its own.
		test.setTimeout(90_000);

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize(KIOSK_VIEWPORT);

		// Accept-and-never-answer, the pattern the reconnect spec established: the
		// socket stays OPEN so the app considers itself connected and dispatches
		// `auth.login`, and nothing ever answers it — which is what holds the
		// loading shell (and its spinner) on screen for Layout's own 3s budget.
		// A route that CLOSED the socket would flap the app through reconnect
		// states instead.
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\/ws(?:\?|$)/, () => {});
		await page.addInitScript(() => {
			localStorage.setItem('auth', 'e2e-never-answered');
		});

		await page.goto('/');
		await waitForAppMount(page);
		// Measured: with no answering backend the offline takeover owns the first
		// paints and the loading shell only reaches the screen a second or two
		// after mount, so this wait is deliberately long.
		const spinner = page.getByTestId('auth-check-spinner');
		await expect(spinner).toBeVisible({ timeout: 30_000 });

		const stilled = await animationOf(page, '[data-testid="auth-check-spinner"]');
		expect(
			stilled.name,
			`the auth-check spinner still declares "${stilled.name}" under reduced motion`,
		).toBe('none');

		await page.emulateMedia({ reducedMotion: 'no-preference' });
		const moving = await animationOf(page, '[data-testid="auth-check-spinner"]');
		expect(
			moving.name,
			'the auth-check spinner does not animate even without a motion preference — this leg proves nothing',
		).not.toBe('none');
		expect(moving.durationMs).toBeGreaterThan(1);

		writeEvidence('reduced-motion-auth-spinner.json', {
			generatedAt: new Date().toISOString(),
			reduce: stilled,
			noPreference: moving,
		});
	});
});
