import type { Page } from '@playwright/test';
import ar from '../../../../packages/i18n/messages/ar.json' with { type: 'json' };
import de from '../../../../packages/i18n/messages/de.json' with { type: 'json' };
import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { expect, test } from './fixtures/index.js';
import { measureHitAreas } from './helpers/hit-area.js';
import { ensureAuthenticated, setLocale } from './helpers/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { expectTextFits, probeTextFit } from './helpers/text-fit.js';

/**
 * The app shell takes the graphite palette and the app typeface: the page
 * scrollbar's thumb and track resolve from --muted-foreground and --background
 * in both themes, and a toast is set in the body's font, not sonner's own
 * system font stack.
 */

for (const scheme of ['dark', 'light'] as const) {
	test(`the page scrollbar is drawn from the graphite tokens in ${scheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), scheme);
		await page.goto('/');
		await ensureAuthenticated(page);
		await (scheme === 'dark'
			? expect(page.locator('html')).toHaveClass(/\bdark\b/)
			: expect(page.locator('html')).not.toHaveClass(/\bdark\b/));

		const colors = await page.evaluate(() => {
			const probe = document.createElement('div');
			probe.style.color = 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)';
			probe.style.backgroundColor = 'var(--background)';
			document.body.append(probe);
			const { color, backgroundColor } = getComputedStyle(probe);
			probe.remove();
			return {
				scrollbar: getComputedStyle(document.documentElement).scrollbarColor,
				thumb: color,
				track: backgroundColor,
				page: getComputedStyle(document.body).backgroundColor,
			};
		});
		expect(colors.scrollbar).toBe(`${colors.thumb} ${colors.track}`);
		expect(colors.track).toBe(colors.page);
	});
}

test('a toast is set in the app typeface', async ({ page, pageRpc }) => {
	await page.goto('/');
	await ensureAuthenticated(page);
	await pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: {
			show: [
				{
					name: 'app-shell-toast-font',
					type: 'info',
					msg: 'App shell toast font',
					is_dismissable: true,
					is_persistent: false,
					duration: 60,
				},
			],
		},
	});
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'App shell toast font' });
	await expect(toast).toBeVisible();

	const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
	expect(bodyFont).not.toBe('');
	expect(await toast.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(bodyFont);
});

// The install banner's instruction is the only place the phone is told how to
// install, so on the narrowest phone it must read whole beside its buttons. An
// Android browser that offered its own prompt adds a second button.
const ANDROID_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const INSTALL_BANNERS = [
	{ code: 'en', messages: en, android: false },
	{ code: 'de', messages: de, android: true },
	{ code: 'ar', messages: ar, android: true },
] as const;

for (const { code, messages, android } of INSTALL_BANNERS) {
	const variant = android ? 'Android prompt' : 'touch browser';
	test.describe(`the install banner on a 320 px ${variant} in ${code}`, { tag: '@mobile-only' }, () => {
		test.use({
			hasTouch: true,
			viewport: { width: 320, height: 640 },
			...(android ? { userAgent: ANDROID_UA } : {}),
		});

		test('its instruction is painted whole beside buttons a thumb can hit', async ({ authedPage: page }) => {
			await setLocale(page, code);
			await page.goto('/');
			await ensureAuthenticated(page);
			await expect(page.locator('html')).toHaveAttribute('dir', code === 'ar' ? 'rtl' : 'ltr');
			const banner = page.getByTestId('pwa-install-banner');
			await expect(banner).toBeVisible();
			if (android) {
				await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true })));
				await expect(banner.getByRole('button', { name: messages['pwa.installButton'], exact: true })).toBeVisible();
			}
			await banner.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
			await page.evaluate(() => document.fonts.ready);

			const instruction = banner.getByText(
				messages[android ? 'pwa.installAndroidDescription' : 'pwa.installDescription'],
				{ exact: true },
			);
			expectTextFits(await probeTextFit(instruction, banner.locator(':scope > div')), `${code} ${variant}`);
			const targets = await measureHitAreas(page, '[data-testid="pwa-install-banner"] button');
			expect(targets).toHaveLength(android ? 2 : 1);
			for (const target of targets) {
				expect(Math.min(target.hitWidth, target.hitHeight), JSON.stringify(target)).toBeGreaterThanOrEqual(44);
				// The compact button keeps its painted size; only its hit area grows.
				expect(target.boxHeight, JSON.stringify(target)).toBeLessThan(target.hitHeight);
			}

			await banner
				.getByRole('button', { name: messages[android ? 'pwa.installLater' : 'pwa.installIosGotIt'], exact: true })
				.click();
			await expect(banner).toBeHidden();
		});
	});
}

/**
 * The install banner rests on the bottom chrome instead of over it: the point a
 * thumb aims at on each dock tab reaches that tab, the banner ends where the
 * dock or the Live bar begins and starts below the header, no pixel past its own
 * box answers as the banner, and its buttons keep 44 px. Where it would take more
 * of the screen than it leaves the page it steps aside, and returns on growth.
 */
async function chromeLayout(page: Page) {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="pwa-install-banner"]')!;
		const box = el.getBoundingClientRect();
		const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top;
		const tabs = [...document.querySelectorAll<HTMLElement>('[id^="mobile-nav-tab-"]')].map((tab) => {
			const rect = tab.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return { id: tab.id, reachesTab: tab.contains(hit), hit: hit?.closest('[data-testid]')?.getAttribute('data-testid') };
		});
		const spill = [box.top - 1, box.bottom + 1].flatMap((y) =>
			[0.1, 0.5, 0.9].map((f) => el.contains(document.elementFromPoint(innerWidth * f, y))),
		);
		return {
			banner: [box.top, box.bottom], innerHeight, tabs, spills: spill.some(Boolean),
			headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
			dockTop: top('[data-testid="dock-nav"]'), liveBarTop: top('[data-testid="live-bar"]'),
		};
	});
}

async function bannerLayout(page: Page) {
	const banner = page.getByTestId('pwa-install-banner');
	await expect(banner).toBeVisible();
	await banner.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
	return chromeLayout(page);
}

function expectTabsReachable(layout: Awaited<ReturnType<typeof chromeLayout>>) {
	expect(layout.tabs).toHaveLength(3);
	for (const tab of layout.tabs) expect(tab.reachesTab, JSON.stringify(layout)).toBe(true);
}

async function dismissBanner(page: Page) {
	const banner = page.getByTestId('pwa-install-banner');
	const targets = await measureHitAreas(page, '[data-testid="pwa-install-banner"] button');
	expect(targets.length).toBeGreaterThan(0);
	for (const target of targets) {
		expect(Math.min(target.hitWidth, target.hitHeight), JSON.stringify(target)).toBeGreaterThanOrEqual(44);
	}
	await banner.getByRole('button', { name: en['pwa.installIosGotIt'], exact: true }).click();
	await expect(banner).toBeHidden();
}

for (const { width, height, fits } of [
	{ width: 360, height: 240, fits: false },
	{ width: 390, height: 260, fits: false },
	{ width: 320, height: 568, fits: true },
	{ width: 390, height: 844, fits: true },
]) {
	test.describe(`the install banner at ${width}×${height}`, { tag: '@mobile-only' }, () => {
		test.use({ hasTouch: true, viewport: { width, height } });

		test('leaves every dock tab, the Live bar and the header to their own taps', async ({ authedPage: page }) => {
			await page.goto('/');
			await ensureAuthenticated(page);
			if (!fits) {
				// No room for it beside the page: it steps aside, owning no tap.
				await expect(page.getByTestId('pwa-install-banner')).toBeAttached();
				await expect(page.getByTestId('pwa-install-banner')).toBeHidden();
				expectTabsReachable(await chromeLayout(page));
				await page.setViewportSize({ width, height: 844 });
			}
			const layout = await bannerLayout(page);
			const at = JSON.stringify(layout);
			expectTabsReachable(layout);
			expect(layout.banner[0], at).toBeGreaterThanOrEqual(layout.headerBottom);
			for (const edge of [layout.dockTop, layout.liveBarTop]) {
				if (edge !== undefined) expect(layout.banner[1], at).toBeLessThanOrEqual(edge);
			}
			expect(layout.spills, at).toBe(false);
			// The end of a page scrolls clear of it: Settings ends the banner's height later.
			await page.locator('#mobile-nav-tab-settings').click();
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			const end = await page.evaluate(() => {
				const banner = document.querySelector('[data-testid="pwa-install-banner"]')!.getBoundingClientRect();
				const last = document.querySelector('#main-content')!.lastElementChild!.getBoundingClientRect();
				const dock = document.querySelector('[data-testid="dock-nav"]')!.getBoundingClientRect();
				return { bannerTop: banner.top, bannerBottom: banner.bottom, contentEnd: last.bottom, dockTop: dock.top };
			});
			expect(end.contentEnd, JSON.stringify(end)).toBeLessThanOrEqual(end.bannerTop + 1);
			expect(end.bannerBottom, JSON.stringify(end)).toBeLessThanOrEqual(end.dockTop + 1);
			await dismissBanner(page);
		});
	});
}

test.describe('the install banner on an Android tablet under desktop chrome', { tag: '@mobile-only' }, () => {
	test.use({ hasTouch: true, viewport: { width: 1024, height: 768 }, userAgent: ANDROID_UA });

	test('rests on the bottom edge, with no dock to clear', async ({ authedPage: page }) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		const layout = await bannerLayout(page);
		const at = JSON.stringify(layout);
		expect(layout.dockTop, at).toBeUndefined();
		expect(layout.banner[1], at).toBeCloseTo(layout.liveBarTop ?? layout.innerHeight, 0);
		expect(layout.spills, at).toBe(false);
		await dismissBanner(page);
	});
});

for (const height of [640, 568]) {
	test.describe(`the install banner on the 320×${height} sign-in screen`, { tag: '@mobile-only' }, () => {
		test.use({ hasTouch: true, viewport: { width: 320, height } });

		test('rests on the bottom edge, with no dock to clear, and leaves Unlock its tap', async ({ page }) => {
			await page.goto('/');
			const unlock = page.getByRole('button', { name: en['auth.unlock'], exact: true });
			await expect(unlock).toBeVisible();
			// No scrolling: Unlock is clear of the banner as the screen first paints.
			const layout = await bannerLayout(page);
			const at = JSON.stringify(layout);
			expect(layout.dockTop, at).toBeUndefined();
			expect(layout.banner[1], at).toBeCloseTo(layout.innerHeight, 0);
			// Unlock is disabled, and so skipped by hit-testing, until a password is typed.
			await page.locator('input[type="password"]').fill('x');
			await expect(unlock).toBeEnabled();
			const box = (await unlock.boundingBox())!;
			const hit = await page.evaluate(
				({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim(),
				{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
			);
			expect(hit, `${at} unlock ${JSON.stringify(box)}`).toBe(en['auth.unlock']);
		});
	});
}

test.describe('the install banner at 390 px wide, as the height changes', { tag: '@mobile-only' }, () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 420 } });
	// 124 resizes, 62 of them checking both screens: on a hosted runner (run 45452645584) this
	// sweep needs about 50 s, and up to 75 s at its slowest step, so the default 30 s cannot hold it.
	test.describe.configure({ timeout: 90_000 });

	test('shows exactly where it leaves the page at least as much room as it takes', async ({ authedPage: page }) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		await expect(page.getByTestId('pwa-install-banner')).toBeAttached();
		// The rule, read from the page: the room runs from the header to the top of
		// the bottom chrome (the Live bar where mounted, else the dock).
		const rule = () =>
			page.evaluate(() => {
				const el = document.querySelector<HTMLElement>('[data-testid="pwa-install-banner"]')!;
				const edge = (document.querySelector('[data-testid="live-bar"]') ?? document.querySelector('[data-testid="dock-nav"]'))!;
				const room = edge.getBoundingClientRect().top - document.querySelector('header')!.getBoundingClientRect().bottom;
				const visible = getComputedStyle(el).visibility !== 'hidden';
				return { holds: visible === el.scrollHeight * 2 <= room, visible, room, height: el.scrollHeight };
			});
		const seen = { live: new Set<boolean>(), settings: new Set<boolean>() };
		// Wide enough to cross the threshold on both screens, whatever the Live bar's height.
		const heights = Array.from({ length: 31 }, (_, i) => 300 + i * 20);
		for (const height of [...heights, ...[...heights].reverse()]) {
			await page.setViewportSize({ width: 390, height });
			for (const screen of ['live', 'settings'] as const) {
				await page.locator(`#mobile-nav-tab-${screen}`).click();
				await expect.poll(async () => (await rule()).holds, { message: `${screen} at ${height}px` }).toBe(true);
				seen[screen].add((await rule()).visible);
			}
		}
		// The sweep crosses the threshold on both screens, so neither state is vacuous.
		expect([...seen.live].sort()).toEqual([false, true]);
		expect([...seen.settings].sort()).toEqual([false, true]);
		// A height change alone on one screen (a raised keyboard) republishes no
		// chrome height, so the rule must still follow it.
		await page.locator('#mobile-nav-tab-settings').click();
		const alone = new Set<boolean>();
		for (const height of [...heights].reverse().concat(heights)) {
			await page.setViewportSize({ width: 390, height });
			await expect.poll(async () => (await rule()).holds, { message: `settings alone at ${height}px` }).toBe(true);
			alone.add((await rule()).visible);
		}
		expect([...alone].sort()).toEqual([false, true]);
	});
});

/**
 * The banner's entrance stays inside the box it rests in. Held from the moment
 * it mounts and sought to its first frame and its midpoint, it ends where the
 * dock or the Live bar begins, and every dock tab and Live bar control still
 * answers its own centre.
 */
for (const { width, height } of [
	{ width: 390, height: 844 },
	{ width: 320, height: 568 },
]) {
	test.describe(`the install banner's entrance at ${width}×${height}`, { tag: '@mobile-only' }, () => {
		test.use({ hasTouch: true, viewport: { width, height } });

		test('never crosses the dock, the Live bar or their controls', async ({ authedPage: page }) => {
			await page.addInitScript(() => {
				const held = new WeakSet<Element>();
				new MutationObserver(() => {
					const el = document.querySelector('[data-testid="pwa-install-banner"]');
					if (!el || held.has(el)) return;
					held.add(el);
					for (const animation of el.getAnimations()) animation.pause();
				}).observe(document, { childList: true, subtree: true });
			});
			await page.goto('/');
			await ensureAuthenticated(page);
			await expect(page.getByTestId('pwa-install-banner')).toBeVisible();
			for (const screen of ['live', 'settings'] as const) {
				await page.locator(`#mobile-nav-tab-${screen}`).click();
				for (const progress of [0, 0.5]) {
					const frame = await page.evaluate((at) => {
						const el = document.querySelector('[data-testid="pwa-install-banner"]')!;
						const animations = el.getAnimations();
						for (const animation of animations) {
							animation.currentTime = Number(animation.effect?.getComputedTiming().duration ?? 0) * at;
						}
						const edges = ['[data-testid="dock-nav"]', '[data-testid="live-bar"]']
							.map((selector) => document.querySelector(selector)?.getBoundingClientRect().top)
							.filter((top): top is number => top !== undefined);
						const controls = [
							...document.querySelectorAll<HTMLElement>('[id^="mobile-nav-tab-"], [data-testid="live-bar"] button'),
						].map((control) => {
							const box = control.getBoundingClientRect();
							const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
							// A disabled control is skipped by hit-testing, so it can only prove the banner is not there.
							const disabled = control.matches(':disabled');
							return { control: control.id || control.textContent?.trim(), disabled, owned: el.contains(hit), reaches: disabled || control.contains(hit) };
						});
						return { held: animations.length, bottom: el.getBoundingClientRect().bottom, edge: Math.min(...edges), controls };
					}, progress);
					const at = `${screen} at ${progress}: ${JSON.stringify(frame)}`;
					expect(frame.held, at).toBeGreaterThan(0);
					expect(frame.bottom, at).toBeLessThanOrEqual(frame.edge + 1);
					for (const control of frame.controls) {
						expect(control.owned, at).toBe(false);
						expect(control.reaches, at).toBe(true);
					}
				}
			}
		});
	});
}

/**
 * A full-height screen that centres its content (sign-in, first-run setup, the
 * stalled auth check) centres it in the room the banner leaves. Where the
 * content fits that room, its control answers its centre at first paint, before
 * any scroll; where it does not (the shortest phones), scrolling the control
 * into view brings it clear of the banner. Both branches must run.
 */
const SWEEP_WIDTHS = [320, 360, 390, 430];
const SWEEP_HEIGHTS = [240, 260, ...Array.from({ length: 10 }, (_, i) => 568 + i * 40), 932];
const isRpcSocket = (url: URL) => isBackendSocket(url) && url.pathname === '/ws';

async function sweepCentredScreen(page: Page, control: string, content: string) {
	// Measure the settled page: fonts loaded and the banner's entrance finished, so
	// a late re-wrap cannot move the control between aligning and measuring it.
	await page.evaluate(async () => {
		await document.fonts.ready;
		const banner = document.querySelector('[data-testid="pwa-install-banner"]');
		await Promise.all(banner?.getAnimations().map((animation) => animation.finished) ?? []);
	});
	const counts = { fits: 0, scrolls: 0, aside: 0 };
	const failures: string[] = [];
	for (const width of SWEEP_WIDTHS) {
		for (const height of SWEEP_HEIGHTS) {
			await page.setViewportSize({ width, height });
			const probe = await page.evaluate(
				async ({ control, content }) => {
					const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
					window.scrollTo(0, 0);
					await frames();
					const banner = document.querySelector<HTMLElement>('[data-testid="pwa-install-banner"]');
					const shown = !!banner && getComputedStyle(banner).visibility !== 'hidden';
					const button = document.querySelector<HTMLElement>(control)!;
					const box = document.querySelector<HTMLElement>(content)!;
					const screen = getComputedStyle(box.parentElement!);
					const padding = Number.parseFloat(screen.paddingTop) + Number.parseFloat(screen.paddingBottom);
					const room = innerHeight - (shown ? banner.getBoundingClientRect().height : 0);
					const reach = () => {
						const rect = button.getBoundingClientRect();
						return { reaches: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), bottom: rect.bottom };
					};
					const first = { scrollY: window.scrollY, ...reach() };
					const rect = box.getBoundingClientRect();
					const fits = rect.height + padding <= room;
					// Centred in the room the banner leaves, not in the whole screen.
					const offCentre = (rect.top + rect.bottom) / 2 - room / 2;
					let scrolled: (ReturnType<typeof reach> & { bannerTop: number; scrollY: number; maxScroll: number }) | null = null;
					if (shown && !fits) {
						button.scrollIntoView({ block: 'nearest', behavior: 'instant' });
						await frames();
						scrolled = {
							...reach(),
							bannerTop: banner.getBoundingClientRect().top,
							scrollY: window.scrollY,
							maxScroll: document.documentElement.scrollHeight - innerHeight,
						};
					}
					return { shown, fits, first, scrolled, room, offCentre };
				},
				{ control, content },
			);
			const at = `${width}×${height} ${JSON.stringify(probe)}`;
			if (!probe.shown) counts.aside++;
			else if (probe.fits) {
				counts.fits++;
				if (probe.first.scrollY !== 0 || !probe.first.reaches) failures.push(`first paint ${at}`);
				if (Math.abs(probe.offCentre) > 1) failures.push(`off centre ${at}`);
			} else {
				counts.scrolls++;
				if (!probe.scrolled?.reaches || probe.scrolled.bottom > probe.scrolled.bannerTop + 1) failures.push(`scrolled ${at}`);
			}
		}
	}
	expect(failures, JSON.stringify(counts)).toEqual([]);
	// Neither branch passes vacuously.
	expect(counts.fits, JSON.stringify(counts)).toBeGreaterThan(0);
	expect(counts.scrolls, JSON.stringify(counts)).toBeGreaterThan(0);
}

for (const mode of ['sign-in', 'set-password'] as const) {
	for (const [code, messages] of [['en', en], ['de', de]] as const) {
		test.describe(`the install banner beside ${mode} in ${code}`, { tag: '@mobile-only' }, () => {
			test.use({ hasTouch: true, viewport: { width: 320, height: 568 } });

			test('leaves the submit button reachable at every phone size', async ({ page }) => {
				if (mode === 'set-password') {
					// The frame a device without a password sends on connect.
					await page.routeWebSocket(isRpcSocket, (socket) => socket.send(JSON.stringify({ status: { set_password: true } })));
				}
				await page.addInitScript((locale) => localStorage.setItem('locale', JSON.stringify({ code: locale })), code);
				await page.goto('/');
				const submit = page.getByRole('button', {
					name: messages[mode === 'sign-in' ? 'auth.unlock' : 'auth.setPassword'],
					exact: true,
				});
				await page.locator('#password').fill('12345678');
				if (mode === 'set-password') await page.locator('#confirm-password').fill('12345678');
				await expect(submit).toBeEnabled();
				await sweepCentredScreen(page, 'form button[type="submit"]', 'div:has(> form)');
			});
		});
	}
}

test.describe('the install banner beside the auth check spinner', { tag: '@mobile-only' }, () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 640 } });

	test('centres the spinner in the room the banner leaves', async ({ page }) => {
		// A saved session against a device that never answers holds the check open.
		await page.routeWebSocket(isRpcSocket, () => {});
		await page.addInitScript(() => localStorage.setItem('auth', 'unanswered-session'));
		await page.goto('/');
		await expect(page.getByTestId('auth-check-spinner')).toBeVisible();
		await expect(page.getByTestId('pwa-install-banner')).toBeVisible();
		const centre = await page.evaluate(() => {
			const banner = document.querySelector('[data-testid="pwa-install-banner"]')!.getBoundingClientRect();
			const spinner = document.querySelector('[data-testid="auth-check-spinner"]')!.parentElement!.getBoundingClientRect();
			return { offCentre: (spinner.top + spinner.bottom) / 2 - (innerHeight - banner.height) / 2, banner: banner.height };
		});
		expect(Math.abs(centre.offCentre), JSON.stringify(centre)).toBeLessThanOrEqual(1);
	});
});

test.describe('the install banner beside the stalled auth check', { tag: '@mobile-only' }, () => {
	test.use({ hasTouch: true, viewport: { width: 320, height: 568 } });

	test('leaves Retry reachable at every phone size', async ({ page }) => {
		// A saved session against a device that accepts the socket and never answers.
		await page.routeWebSocket(isRpcSocket, () => {});
		await page.addInitScript(() => localStorage.setItem('auth', 'unanswered-session'));
		await page.goto('/');
		await expect(page.getByTestId('auth-timeout')).toBeVisible();
		await sweepCentredScreen(page, '[data-testid="auth-timeout"] button', '[data-testid="auth-timeout"]');
	});
});
