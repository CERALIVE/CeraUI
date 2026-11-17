import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { focusMainContent } from './helpers/focus-main-content.js';
import { measureHitAreas } from './helpers/hit-area.js';
import { ensureAuthenticated, navigateTo, setLocale, setTheme } from './helpers/index.js';

/**
 * The Live screen and the Encoder dialog after the final design pass (Live
 * screen contract, change 6), @a11y.
 *
 * `caps-full` advertises composition, composition-geometry and audio_mix, so the
 * program desk carries the layout controls, the Audio card carries the mixer
 * strips and the preview carries the hardware-encode control. Every check is a
 * measured property of the rendered page, in the languages and at the sizes the
 * contract names:
 *
 *  - nothing overflows sideways at 375x812, 768x1024, 1280x900 and 1024x600, idle
 *    and live, in English, Spanish and Arabic;
 *  - in touch layout every control of the Audio card, the layout controls and
 *    the Live bar answers to at least 44 px on its shorter side (DESIGN.md TT-1),
 *    at 375x812 and at the 1024x600 kiosk; switches and slider thumbs reach it
 *    through the token layer's `::after` hit area, never a grown box;
 *  - every slider has a name, every button has a name at phone width, and text
 *    meets AA contrast in dark and light;
 *  - keyboard focus never lands under the fixed Live bar (WCAG 2.4.11);
 *  - sliders draw their track and fill, and run with the reading direction;
 *  - setup values and source names stay readable at phone width;
 *  - with reduced motion nothing on the screen keeps animating.
 */

test.use({ backendScenario: 'caps-full' });

const MAIN = 'RØDE AI-Micro';
const SECOND = 'Elgato Wave:3';
const SEED = {
	source: 'usb',
	srtla_addr: '127.0.0.1',
	srtla_port: 5000,
	asrc: MAIN,
	audio_inputs: [
		{ id: MAIN, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
		{ id: SECOND, tracks: [2], gain_db: -6, mute: true, delay_ms: 120 },
	],
};

const VIEWPORTS = [
	{ width: 375, height: 812 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 900 },
	{ width: 1024, height: 600 },
] as const;
const PHONE = VIEWPORTS[0];
const DESKTOP = VIEWPORTS[2];
const KIOSK = VIEWPORTS[3];

const TARGET_PX = 44;
const PHONES = [PHONE, { width: 360, height: 640 }, { width: 320, height: 640 }];
const TOUCH_REGIONS = ['audio-card', 'layout-controls', 'live-bar'] as const;
const CONTROLS =
	'button, [role="slider"], [role="switch"], [role="radio"], [role="combobox"], input:not([type="hidden"]), select, a[href], summary';

type State = 'idle' | 'live';

interface OpenOptions {
	theme?: 'dark' | 'light';
	locale?: string;
	touch?: boolean;
}

async function openLive(page: Page, options: OpenOptions = {}): Promise<void> {
	const url = options.touch ? '/?mode=touch' : '/';
	await page.goto(url);
	await ensureAuthenticated(page);
	await setTheme(page, options.theme ?? 'dark');
	await setLocale(page, options.locale ?? 'en');
	// Theme, locale and touch layout all apply at app init.
	await page.goto(url);
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
	await expect(cockpit(page)).toBeVisible({ timeout: 20_000 });
}

function cockpit(page: Page) {
	return page.locator('[data-testid="idle-cockpit"], [data-testid="live-cockpit"]').first();
}

async function enableComposition(page: Page): Promise<void> {
	const enable = page.getByTestId('composition-enable');
	if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click();
	await expect(page.getByTestId('composition-layout-selector')).toBeVisible();
}

/**
 * Start and Stop go through the Live bar, as the operator does. The test's own
 * backend socket is not used for them: the backend prunes a socket with no
 * inbound frame for 15 s, and these tests spend longer than that between calls.
 * The bar's action is its last button in either state (Start; minus, plus, Stop).
 */
async function goLive(page: Page): Promise<void> {
	await page.getByTestId('live-bar').getByRole('button').last().click();
	await expect(page.getByTestId('live-cockpit')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('live-cockpit').getByTestId('audio-mixer-next-start')).toBeVisible({
		timeout: 15_000,
	});
}

async function goIdle(page: Page): Promise<void> {
	await page.getByTestId('live-bar').getByRole('button').last().click();
	await expect(page.getByTestId('live-cockpit').getByTestId('audio-mixer-next-start')).toHaveCount(0, {
		timeout: 15_000,
	});
}

async function overflowPx(page: Page): Promise<number> {
	return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function axe(page: Page, include: string, rules: string[]) {
	const results = await new AxeBuilder({ page }).include(include).withRules(rules).analyze();
	return results.violations.map((violation) => ({
		id: violation.id,
		nodes: violation.nodes.map((node) => {
			const ratio = (node.any[0]?.data as { contrastRatio?: number } | undefined)?.contrastRatio;
			return ratio === undefined ? node.target.join(' ') : `${node.target.join(' ')} (${ratio}:1)`;
		}),
	}));
}

async function regionTargets(page: Page) {
	const measured = await Promise.all(
		TOUCH_REGIONS.map(async (region) =>
			(await measureHitAreas(page, `[data-testid="${region}"] :is(${CONTROLS})`)).map((area) => ({
				region,
				...area,
			})),
		),
	);
	return measured.flat().filter((area) => area.boxWidth > 0 && area.boxHeight > 0);
}

/**
 * Tab through the cockpit and report every stop outside the Live bar whose
 * bottom edge falls below the bar's top edge.
 */
async function focusStopsUnderTheBar(page: Page, configuration: string): Promise<string[]> {
	await focusMainContent(page, configuration);
	const hidden: string[] = [];
	let entered = false;
	for (let press = 0; press < 160; press += 1) {
		await page.keyboard.press('Tab');
		const stop = await page.evaluate(() => {
			const element = document.activeElement as HTMLElement | null;
			const root = document.querySelector('[data-testid="idle-cockpit"], [data-testid="live-cockpit"]');
			const bar = document.querySelector('[data-testid="live-bar"]');
			if (element === null || root === null || bar === null || !root.contains(element)) return null;
			if (bar.contains(element)) return { inBar: true, name: '', bottom: 0, barTop: 0 };
			const host = element.closest('[data-testid]');
			return {
				inBar: false,
				name: `${element.dataset.testid ?? host?.getAttribute('data-testid') ?? element.tagName} (${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? ''})`,
				bottom: element.getBoundingClientRect().bottom,
				barTop: bar.getBoundingClientRect().top,
			};
		});
		if (stop === null) {
			if (entered) break;
			continue;
		}
		entered = true;
		if (!stop.inBar && stop.bottom > stop.barTop + 0.5) {
			hidden.push(`${stop.name}: bottom ${Math.round(stop.bottom)} below the bar at ${Math.round(stop.barTop)}`);
		}
	}
	expect(entered, 'Tab never reached the cockpit').toBe(true);
	return hidden;
}

// Each test drives its own viewports, so it runs once, on desktop.
test.describe('@a11y Live screen design pass — caps-full', { tag: '@desktop-only' }, () => {
	test.beforeEach(async ({ backendRpc }) => {
		await backendRpc.call(['streaming', 'setConfig'], SEED);
	});

	test('nothing overflows sideways at four sizes, idle and live, in English, Spanish and Arabic @a11y', async ({ page }) => {
		test.setTimeout(240_000);
		const overflowing: string[] = [];
		for (const locale of ['en', 'es', 'ar']) {
			await page.setViewportSize(DESKTOP);
			await openLive(page, { locale });
			await enableComposition(page);
			for (const state of ['idle', 'live'] as State[]) {
				if (state === 'live') await goLive(page);
				for (const viewport of VIEWPORTS) {
					await page.setViewportSize(viewport);
					await expect(cockpit(page)).toBeVisible();
					const px = await overflowPx(page);
					if (px > 1) overflowing.push(`${locale} ${state} ${viewport.width}x${viewport.height}: ${px}px`);
				}
				if (state === 'live') await goIdle(page);
			}
		}
		expect(overflowing).toEqual([]);
	});

	test('touch layout gives every Audio, layout and Live bar control a 44 px hit area @a11y', async ({ page }) => {
		test.setTimeout(180_000);
		const short: string[] = [];
		const grown: string[] = [];
		for (const viewport of [PHONE, KIOSK]) {
			await page.setViewportSize(viewport);
			await openLive(page, { touch: true });
			await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'touch');
			await enableComposition(page);
			for (const state of ['idle', 'live'] as State[]) {
				if (state === 'live') await goLive(page);
				for (const area of await regionTargets(page)) {
					const label = `${viewport.width}x${viewport.height} ${state} ${area.region} ${area.name}`;
					if (Math.min(area.hitWidth, area.hitHeight) < TARGET_PX - 0.5) {
						short.push(`${label}: ${Math.round(area.hitWidth)}x${Math.round(area.hitHeight)}`);
					}
				}
				// A slider thumb reaches the target through its hit area; its paint stays small.
				for (const thumb of await measureHitAreas(page, '[data-slot="slider-thumb"]')) {
					if (Math.max(thumb.boxWidth, thumb.boxHeight) >= TARGET_PX - 0.5) grown.push(thumb.name);
				}
				if (state === 'live') await goIdle(page);
			}
		}
		expect(short, 'controls below the 44 px touch target').toEqual([]);
		expect(grown, 'slider thumbs grown instead of given a hit area').toEqual([]);
	});

	for (const theme of ['dark', 'light'] as const) {
	test(`default layout gives every Audio, layout and Live bar control a 44 px target on a phone, ${theme} @a11y`, async ({ page }) => {
		test.setTimeout(300_000);
		const short: string[] = [];
		const seen = new Set<string>();
		{
			for (const locale of ['en', 'es', 'ar'] as const) {
				await page.setViewportSize(PHONE);
				await openLive(page, { theme, locale });
				await expect(page.locator('html')).not.toHaveAttribute('data-layout-mode', 'touch');
				await enableComposition(page);
				for (const state of ['idle', 'live'] as State[]) {
					if (state === 'live') await goLive(page);
					for (const viewport of PHONES) {
						await page.setViewportSize(viewport);
						for (const area of await regionTargets(page)) {
							seen.add(area.region);
							if (Math.min(area.hitWidth, area.hitHeight) < TARGET_PX - 0.5) {
								short.push(
									`${theme} ${locale} ${viewport.width}x${viewport.height} ${state} ${area.region} ${area.name}: ${Math.round(area.hitWidth)}x${Math.round(area.hitHeight)}`,
								);
							}
						}
					}
					await page.setViewportSize(PHONE);
					if (state === 'live') await goIdle(page);
				}
			}
		}
		expect([...seen].sort()).toEqual([...TOUCH_REGIONS].sort());
		expect(short, 'controls below the 44 px target').toEqual([]);
	});
	}

	test('sliders, buttons and fields carry names, and text meets AA contrast in dark and light @a11y', async ({ page }) => {
		test.setTimeout(240_000);
		const found: Record<string, unknown> = {};
		for (const theme of ['dark', 'light'] as const) {
			await page.setViewportSize(DESKTOP);
			await openLive(page, { theme });
			await enableComposition(page);
			for (const state of ['idle', 'live'] as State[]) {
				if (state === 'live') await goLive(page);
				const root = `[data-testid="${state}-cockpit"]`;
				for (const viewport of [DESKTOP, PHONE]) {
					await page.setViewportSize(viewport);
					await expect(page.locator(root)).toBeVisible();
					// The encoder cell joins the live cockpit with the first load reading (a 2 s
					// tick); scan only once it is there, so its text is always measured.
					if (state === 'live') await expect(page.locator(root).getByTestId('encoder-status-headline')).toBeVisible();
					const violations = await axe(page, root, [
						'aria-input-field-name',
						'button-name',
						'label',
						'color-contrast',
					]);
					if (violations.length > 0) found[`${theme} ${state} ${viewport.width}`] = violations;
					const unnamed = await page.locator(`${root} [role="slider"]:not([aria-label]):not([aria-labelledby])`).count();
					if (unnamed > 0) found[`${theme} ${state} ${viewport.width} unnamed sliders`] = unnamed;
				}
				if (state === 'live') await goIdle(page);
			}

			await page.setViewportSize(DESKTOP);
			await page.getByTestId('open-encoder-dialog').first().click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			const inDialog = await axe(page, '[role="dialog"]', [
				'aria-input-field-name',
				'button-name',
				'label',
				'color-contrast',
			]);
			if (inDialog.length > 0) found[`${theme} encoder`] = inDialog;
			const unnamedInDialog = await dialog.locator('[role="slider"]:not([aria-label]):not([aria-labelledby])').count();
			if (unnamedInDialog > 0) found[`${theme} encoder unnamed sliders`] = unnamedInDialog;
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
		}
		expect(found).toEqual({});
	});

	test('keyboard focus never lands under the fixed Live bar @a11y', async ({ page }) => {
		test.setTimeout(240_000);
		// Instant scrolling: the position a focus scroll settles on is the one measured.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize(DESKTOP);
		await openLive(page);
		await enableComposition(page);
		const hidden: string[] = [];
		for (const state of ['idle', 'live'] as State[]) {
			if (state === 'live') await goLive(page);
			for (const viewport of [DESKTOP, KIOSK, PHONE]) {
				await page.setViewportSize(viewport);
				await page.evaluate(() => window.scrollTo(0, 0));
				for (const stop of await focusStopsUnderTheBar(page, `${state} ${viewport.width}x${viewport.height}`)) {
					hidden.push(`${state} ${viewport.width}x${viewport.height} ${stop}`);
				}
			}
			if (state === 'live') await goIdle(page);
		}
		expect(hidden).toEqual([]);
	});

	test('sliders draw their track and fill, and run with the reading direction @a11y', async ({ page }) => {
		test.setTimeout(180_000);
		const sliders = (state: State) =>
			page.locator(
				`[data-testid="${state}-cockpit"] :is([data-testid="layout-controls"], [data-testid="audio-card"], [data-testid="live-bar"]) [data-slot="slider"]`,
			);

		const wrong: string[] = [];
		const compared = new Set<string>();
		for (const locale of ['en', 'ar']) {
			await page.setViewportSize(DESKTOP);
			await openLive(page, { locale });
			await enableComposition(page);
			for (const state of ['idle', 'live'] as State[]) {
				if (state === 'live') await goLive(page);
				const all = await sliders(state).all();
				expect(all.length, `${locale} ${state}: no slider found`).toBeGreaterThan(0);
				for (const slider of all) {
					const name = (await slider.getByRole('slider').getAttribute('aria-label')) ?? 'unnamed slider';
					await slider.scrollIntoViewIfNeeded();
					// One synchronous read of the value and the geometry it is drawn with, so a
					// value the device reconciles later (the live bitrate) cannot race it.
					const drawn = await slider.evaluate((root) => {
						const track = root.querySelector('[data-slot="slider-track"]')?.getBoundingClientRect();
						const range = root.querySelector('[data-slider-range]')?.getBoundingClientRect();
						const knob = root.querySelector('[role="slider"]');
						const box = knob?.getBoundingClientRect();
						const value = Number(knob?.getAttribute('aria-valuenow'));
						const min = Number(knob?.getAttribute('aria-valuemin'));
						const max = Number(knob?.getAttribute('aria-valuemax'));
						return {
							trackHeight: track?.height ?? 0,
							rangeWidth: range?.width ?? 0,
							rangeHeight: range?.height ?? 0,
							fraction: (value - min) / (max - min),
							position: track && box ? (box.left + box.width / 2 - track.left) / track.width : Number.NaN,
						};
					});
					const where = `${locale} ${state} ${name}`;
					if (drawn.trackHeight < 2) wrong.push(`${where}: the track is not drawn`);
					if (drawn.fraction > 0.02 && (drawn.rangeHeight <= 0 || drawn.rangeWidth <= 0)) {
						wrong.push(`${where}: the fill is not drawn`);
					}
					// The minimum sits at the inline start: left in English, right in Arabic.
					// A value near the middle looks the same either way, so it proves nothing.
					const expected = locale === 'ar' ? 1 - drawn.fraction : drawn.fraction;
					if (Math.abs(drawn.fraction - 0.5) > 0.1) {
						compared.add(locale);
						if (!(Math.abs(drawn.position - expected) < 0.1)) {
							wrong.push(`${where}: value ${drawn.fraction.toFixed(2)} drawn at ${drawn.position.toFixed(2)} of the track`);
						}
					}
				}
				if (state === 'live') await goIdle(page);
			}
		}
		expect(wrong).toEqual([]);
		expect([...compared].sort(), 'each language must compare at least one slider away from its middle').toEqual(['ar', 'en']);
	});

	test('setup values, the destination check and source names stay readable on a phone @a11y', async ({ page }) => {
		test.setTimeout(120_000);
		const clipped: string[] = [];
		for (const locale of ['en', 'de']) {
			await page.setViewportSize(PHONE);
			await openLive(page, { locale });
			await expect(page.getByTestId('output-card')).toBeVisible();
			const cut = await page.evaluate(() =>
				[
					...document.querySelectorAll<HTMLElement>(
						'[data-testid="setup-row"] p, [data-testid^="source-row-name-"]',
					),
				]
					.filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
					.map((element) => (element.textContent ?? '').trim()),
			);
			for (const text of cut) clipped.push(`${locale}: ${text}`);
			// The check's state is read as words at phone width too, never as a dot alone.
			const checkWords = await page
				.getByTestId('destination-traffic-light')
				.evaluate((chip) => (chip as HTMLElement).innerText.trim());
			if (checkWords === '') clipped.push(`${locale}: the destination check shows no words`);
		}
		expect(clipped).toEqual([]);
	});

	test('with reduced motion nothing on the Live screen keeps animating @a11y', async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize(DESKTOP);
		await openLive(page);
		await enableComposition(page);
		await goLive(page);
		const pulse = page.getByTestId('live-summary-strip').locator('span[aria-hidden="true"]').first();

		// Non-vacuity: without the preference the live dot does animate.
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect.poll(() => pulse.evaluate((dot) => dot.getAnimations().length)).toBeGreaterThan(0);

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.getByTestId('composition-layout-pbp-left-right').click();
		await page.getByTestId('composition-layout-pip-top-right').click();
		await page.getByTestId('preview-disclosure').locator('summary').click();
		await page.getByTestId('preview-disclosure').locator('summary').click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					document
						.getAnimations()
						.filter((animation) => animation.playState === 'running')
						.map((animation) => {
							const target = (animation.effect as KeyframeEffect | null)?.target as HTMLElement | null;
							return target?.dataset.testid ?? target?.className.toString() ?? 'unknown';
						}),
				),
			)
			.toEqual([]);
		await goIdle(page);
	});
});
