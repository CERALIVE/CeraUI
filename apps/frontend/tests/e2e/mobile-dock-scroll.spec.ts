import de from '../../../../packages/i18n/messages/de.json' with { type: 'json' };
import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { expect, type Locator, type Page, test } from './fixtures/index.js';
import { ensureAuthenticated } from './helpers/index.js';

const controls =
	':is(button, a[href], input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role=button], [role=switch], [role=combobox]):not(:disabled, [aria-disabled=true], [aria-hidden=true]):visible';

async function settledDestination(page: Page, destination: string) {
	const tab = page.locator(`#mobile-nav-tab-${destination}`);
	await expect(tab).toHaveAttribute('aria-current', 'page');
	await expect(tab).toBeEnabled();
	await expect(page.getByTestId('destination-content')).toHaveCount(1);
	const view = page.locator(`[data-destination="${destination}"]`);
	await expect(view).toBeVisible();
	await view.evaluate(async () => {
		await document.fonts.ready;
	});
	// Svelte's delayed intro keeps its dummy animation in the list, as `finished`,
	// until it is cancelled and the fly takes over, so an empty list is the only
	// settled state; counting `running` alone returns inside that gap.
	await expect
		.poll(() => view.evaluate((element) => element.getAnimations().length), { timeout: 5_000 })
		.toBe(0);
	return view;
}

async function openDestination(page: Page, destination: string, locale = 'en', theme = 'light', isolateDock = true) {
	await page.addInitScript(({ locale, theme, isolateDock }) => {
		localStorage.setItem('locale', JSON.stringify({ code: locale }));
		localStorage.setItem('theme', JSON.stringify(theme));
		localStorage.setItem('mode-watcher-mode', theme);
		if (isolateDock) {
			// Suppress the install offer after parsing, without engaging the
			// inline standalone PWA boot watchdog on the cold dev server.
			Object.defineProperty(navigator, 'standalone', {
				get: () => document.readyState !== 'loading',
			});
		}
	}, { locale, theme, isolateDock });
	// The development Identity destination's hash is its label, not its key.
	await page.goto(`/#${destination === 'identity' ? '_identity' : destination}`);
	await ensureAuthenticated(page);
	const content = await settledDestination(page, destination);
	await expect(page.locator('html')).toHaveAttribute('lang', locale);
	await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
	if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
	else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
	if (isolateDock) await expect(page.getByTestId('pwa-install-banner')).toHaveCount(0);
	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
	return content;
}

async function tapAtEnd(page: Page, control: Locator, minimumGap?: number) {
	await expect(control).toBeVisible();
	const element = await control.elementHandle();
	const target = await element.evaluate(async (element) => {
		// A focus/scroll-to-control request can move back up from the absolute end.
		// Use native end alignment, with no Playwright auto-scroll or hit retargeting.
		element.scrollIntoView({ block: 'end', behavior: 'instant' });
		await new Promise(requestAnimationFrame);
		const { x, y, width, height, bottom } = element.getBoundingClientRect();
		const centre = { x: x + width / 2, y: y + height / 2 };
		const hit = document.elementFromPoint(centre.x, centre.y);
		const nav = document.querySelector('[data-testid=dock-nav]');
		const dock = nav?.parentElement;
		const dockTop = dock?.getBoundingClientRect().top;
		const visibleTop = dockTop === undefined ? null : Math.min(dockTop, ...Array.from(
			nav?.querySelectorAll('button[aria-current=page] [aria-hidden=true]') ?? [],
			(decoration) => decoration.getBoundingClientRect().top,
		));
		return {
			...centre,
			top: y,
			bottom,
			visibleTop,
			reachable: element.contains(hit),
			hit: hit?.closest('button')?.id || hit?.tagName,
			dock: dock?.contains(hit),
			gap: visibleTop === null ? null : visibleTop - bottom,
			control: element.getAttribute('data-testid') ?? element.textContent?.trim(),
			scrollPadding: getComputedStyle(document.documentElement).scrollPaddingBottom,
		};
	});
	// Real touch activation, not dispatchEvent or a locator tap that could scroll
	// away from the failing coordinates. A trusted click must reach this control.
	const activated = await element.evaluateHandle((element) => {
		const receipt = { trusted: false };
		element.addEventListener('click', (event) => { receipt.trusted = event.isTrusted; }, { once: true });
		return receipt;
	});
	expect.soft(target.reachable, JSON.stringify(target)).toBe(true);
	if (minimumGap !== undefined) {
		const detail = JSON.stringify(target);
		expect.soft(target.top, detail).toBeGreaterThanOrEqual(0);
		expect.soft(target.bottom, detail).toBeLessThan(target.visibleTop ?? 0);
		expect.soft(target.y, detail).toBeLessThan(target.visibleTop ?? 0);
		expect.soft(target.gap ?? 0, detail).toBeGreaterThan(0);
		// Chromium rounds integer scroll offsets to the nearest CSS pixel.
		expect.soft(target.gap ?? 0, detail).toBeGreaterThanOrEqual(minimumGap - 0.5);
	}
	await page.touchscreen.tap(target.x, target.y);
	expect.soft(await activated.jsonValue(), JSON.stringify(target)).toEqual({ trusted: true });
	await activated.dispose();
	await element.dispose();
}

async function spacingUnit(page: Page) {
	return page.evaluate(() => {
		const probe = document.createElement('div');
		probe.style.width = 'var(--spacing)';
		document.body.append(probe);
		const unit = probe.getBoundingClientRect().width;
		probe.remove();
		return unit;
	});
}

async function lastControl(view: Locator) {
	const candidates = view.locator(controls);
	const count = await candidates.count();
	expect(count, 'at least one visible enabled control in the destination').toBeGreaterThan(0);
	const last = candidates.last();
	await expect(last).toBeVisible();
	return last;
}

const destinationGroups = [
	{ destinations: ['live', 'network', 'settings'], tag: ['@mobile-only'] },
	{ destinations: ['identity', 'devtools'], tag: ['@mobile-only', '@dev-only'] },
];

for (const { destinations, tag } of destinationGroups) {
	test.describe(`fixed dock: ${destinations.join(', ')} (#737)`, { tag }, () => {
		test.use({ hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
		for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
			for (const locale of ['en', 'de', 'ar']) {
				for (const theme of ['light', 'dark']) {
					for (const destination of destinations) {
						test(`${viewport.width}x${viewport.height} ${locale} ${theme}: ${destination}'s last control takes a tap`, async ({ page }) => {
							await page.setViewportSize(viewport);
							const view = await openDestination(page, destination, locale, theme);
							const unit = await spacingUnit(page);
							expect(unit).toBeGreaterThan(0);
							await tapAtEnd(page, await lastControl(view), 2 * unit);
						});
					}
				}
			}
		}
	});
}

test.describe('fixed dock edge cases (#737)', { tag: '@mobile-only' }, () => {
	test.use({ hasTouch: true, isMobile: true, reducedMotion: 'reduce' });

	test('320x568 German light: tapping modem Configure opens its sheet', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		const network = await openDestination(page, 'network', 'de');
		const configure = network.getByTestId('open-modem-config-dialog').last();
		await expect(configure).toHaveAccessibleName(de['network.view.configure']);
		await tapAtEnd(page, configure, 2 * await spacingUnit(page));
		await expect(page.getByRole('dialog')).toBeVisible();
	});

	test('portrait tablet reserves the measured safe area; landscape rail releases it', async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 920 });
		const settings = await openDestination(page, 'settings');
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
		const gap = 2 * await spacingUnit(page);
		const dock = page.getByTestId('dock-nav').locator('..');
		const observed = () => dock.evaluate((element) => ({
			safeArea: getComputedStyle(element).paddingBottom,
			height: Math.ceil(element.getBoundingClientRect().height),
			pageRoom: Number.parseFloat(getComputedStyle(document.querySelector('main') ?? document.body).paddingBottom),
			scrollRoom: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom),
		}));
		await expect.poll(async () => {
			const { safeArea, height, pageRoom, scrollRoom } = await observed();
			return { safeArea, pageRoom: pageRoom - height, scrollRoom: scrollRoom - height };
		}).toEqual({ safeArea: '34px', pageRoom: gap, scrollRoom: gap });
		await tapAtEnd(page, settings.locator(controls).last(), gap);
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await page.setViewportSize({ width: 800, height: 480 });
		await expect(dock).toHaveCount(0);
		await expect(page.getByTestId('rail-nav')).toBeVisible();
		await expect(page.locator('main')).toHaveCSS('padding-bottom', '0px');
		await expect(page.locator('html')).toHaveCSS('scroll-padding-bottom', 'auto');
	});

	test('the dock does not intercept a focused form in a keyboard-height sheet', async ({ page }) => {
		await openDestination(page, 'settings');
		await page.locator('main').getByTestId('settings-entry-devicePassword').click();
		const dialog = page.getByRole('dialog');
		const field = dialog.locator('#device-password');
		await field.tap();
		await expect(field).toBeFocused();
		// Headless Chromium has no OS keyboard; exercise the shorter viewport
		// while a real sheet input has focus, then verify touch and text input.
		await page.setViewportSize({ width: 390, height: 440 });
		await field.evaluate((element) => element.scrollIntoView({ block: 'center' }));
		await tapAtEnd(page, field);
		await page.keyboard.type('keyboard test');
		await expect(field).toHaveValue('keyboard test');
	});

	test('phone clearance falls back to the existing main padding before the first dock measurement', async ({ page }) => {
		await page.addInitScript(() => {
			window.ResizeObserver = class extends ResizeObserver {
				override observe(target: Element, options?: ResizeObserverOptions) {
					if (target.querySelector(':scope > [data-testid=dock-nav]')) {
						window.addEventListener('test-observe-dock', () => super.observe(target, options), { once: true });
						return;
					}
					super.observe(target, options);
				}
			};
		});
		await openDestination(page, 'live');
		const main = page.locator('main');
		const root = page.locator('html');
		const legacyRoom = await main.evaluate((el) => getComputedStyle(el).paddingBottom);
		const gap = 2 * await spacingUnit(page);
		expect(Number.parseFloat(legacyRoom)).toBeGreaterThan(0);
		await page.locator('#mobile-nav-tab-settings').tap();
		await settledDestination(page, 'settings');
		await expect(root).toHaveCSS('--mobile-dock-offset', '');
		const fallbackRoom = `${Number.parseFloat(legacyRoom) + gap}px`;
		await expect(main).toHaveCSS('padding-bottom', fallbackRoom);
		await expect(root).toHaveCSS('scroll-padding-bottom', fallbackRoom);
		await page.evaluate(() => window.dispatchEvent(new Event('test-observe-dock')));
		const measured = await page.getByTestId('dock-nav').locator('..').evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
		await expect(root).toHaveCSS('--mobile-dock-offset', `${measured}px`);
		await expect(main).toHaveCSS('padding-bottom', `${measured + gap}px`);
		await expect(root).toHaveCSS('scroll-padding-bottom', `${measured + gap}px`);
	});

	test('install banner and Live bar keep precedence across navigation in both directions', async ({ page }) => {
		await openDestination(page, 'live', 'en', 'light', false);
		const live = page.getByTestId('live-bar');
		const banner = page.getByTestId('pwa-install-banner');
		const dock = page.getByTestId('dock-nav').locator('..');
		const root = page.locator('html');
		const main = page.locator('main');
		const measure = (locator: Locator) => locator.evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
		const liveRoom = await main.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom));
		const gap = 2 * await spacingUnit(page);
		const assertClearance = async (destination: 'live' | 'settings', bannerShown: boolean) => {
			await settledDestination(page, destination);
			const dockRoom = await measure(dock);
			await expect(root).toHaveCSS('--mobile-dock-offset', `${dockRoom}px`);
			const bar = destination === 'live' ? await measure(live) : 0;
			const pageRoom = destination === 'live' ? liveRoom : dockRoom + gap;
			const chromeRoom = destination === 'live' ? liveRoom + bar : dockRoom;
			if (bannerShown) await expect(banner).toBeVisible();
			else await expect(banner).toBeHidden();
			const bannerRoom = bannerShown ? await measure(banner) : 0;
			await expect(main).toHaveCSS('padding-bottom', `${pageRoom}px`);
			await expect(root).toHaveCSS('padding-bottom', `${bannerRoom}px`);
			const scrollPadding = bannerShown
				? Math.max(dockRoom, chromeRoom) + bannerRoom
				: destination === 'live' ? chromeRoom : dockRoom + gap;
			await expect(root).toHaveCSS('scroll-padding-bottom', `${scrollPadding}px`);
			console.log('dock cascade', { destination, bannerShown, pageRoom, bannerRoom, scrollPadding });
		};
		await assertClearance('live', true);
		await page.locator('#mobile-nav-tab-settings').tap();
		await assertClearance('settings', true);
		await page.locator('#mobile-nav-tab-live').tap();
		await assertClearance('live', true);
		await banner.getByRole('button', { name: en['pwa.installIosGotIt'] }).tap();
		await assertClearance('live', false);
		await page.locator('#mobile-nav-tab-settings').tap();
		await assertClearance('settings', false);
		await page.locator('#mobile-nav-tab-live').tap();
		await assertClearance('live', false);
	});
});
