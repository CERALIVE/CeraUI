import type { CDPSession, Locator } from '@playwright/test';
import { expect, test } from './fixtures/index.js';
import { SystemLogsPage } from './pages/system-logs.js';

const OPENING = { width: 390, height: 844 };
const SIZES = [
	{ width: 667, height: 350 }, { width: 390, height: 260 },
	{ width: 390, height: 440 }, { width: 360, height: 360 }, { width: 320, height: 480 },
	{ width: 844, height: 390 }, { width: 740, height: 360 }, { width: 667, height: 375 },
] as const;
const LOCALES = ['en', 'es', 'de', 'fr', 'pt-BR', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;

test.use({ hasTouch: true });

async function region(locator: Locator) {
	return locator.evaluate((el) => {
		const box = el.getBoundingClientRect();
		let top = Math.max(0, box.top);
		let bottom = Math.min(innerHeight, box.bottom);
		const offsets: number[] = [];
		let remaining = 0;
		for (let node: Element | null = el; node; node = node.parentElement) {
			const overflow = getComputedStyle(node).overflowY;
			const rect = node.getBoundingClientRect();
			if (node !== el && overflow !== 'visible') {
				top = Math.max(top, rect.top);
				bottom = Math.min(bottom, rect.bottom);
			}
			if (overflow === 'auto' || overflow === 'scroll') {
				offsets.push(node.scrollTop);
				remaining += Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
			}
		}
		const x = box.left + box.width / 2;
		const y = (top + bottom) / 2;
		return {
			height: el.clientHeight, boxHeight: box.height, visible: Math.max(0, bottom - top), offsets, remaining,
			scroll: el.scrollTop, content: el.scrollHeight, x, y,
			hit: top < bottom && el.contains(document.elementFromPoint(x, y)),
		};
	});
}

async function settleScroll(locator: Locator) {
	await locator.evaluate(async (el) => {
		let quiet = 0;
		let previous = '';
		while (quiet < 4) {
			await new Promise(requestAnimationFrame);
			const offsets = [];
			for (let node: Element | null = el; node; node = node.parentElement) offsets.push(node.scrollTop);
			const current = offsets.join(',');
			quiet = current === previous ? quiet + 1 : 0;
			previous = current;
		}
	});
}

async function swipe(session: CDPSession, { x, y }: { x: number; y: number }, distance: number) {
	await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	for (const step of [0.25, 0.5, 0.75, 1]) {
		await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * step }] });
	}
	await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('Raw results stay visible on a second short resize after using Time @mobile-only', async ({ page }, info) => {
	const logs = new SystemLogsPage(page);
	await logs.open({ locale: 'en', size: OPENING, touch: false, scheme: 'light' });
	await logs.show('raw');
	const filters = page.getByTestId('raw-filters');
	const toggle = page.getByTestId('raw-filters-toggle');
	const search = page.getByTestId('raw-search');
	const list = page.getByTestId('raw-scroller');
	const raw = page.getByTestId('system-logs-view').getByRole('tab').nth(1);
	const focusSearch = async () => {
		await raw.focus();
		await page.keyboard.press('Tab');
		await expect(filters.getByRole('radio', { checked: true }).first()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(search).toBeFocused();
	};
	await toggle.tap();
	await focusSearch();
	await page.setViewportSize({ width: 667, height: 350 });
	await logs.settle();
	const time = page.getByTestId('raw-time');
	await time.tap();
	await expect(page.getByRole('listbox')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await expect(time).toBeFocused();

	await page.setViewportSize(OPENING);
	await focusSearch();
	await page.setViewportSize({ width: 390, height: 260 });
	await logs.settle();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(search).toBeFocused();
	const results = await region(list);
	const focus = await region(search);
	await info.attach('second short resize', { body: JSON.stringify({ results, focus }), contentType: 'application/json' });
	expect(focus.visible + 0.5).toBeGreaterThanOrEqual(focus.boxHeight);
	expect(results.visible, '88 px of entries must remain visible without scrolling again').toBeGreaterThanOrEqual(87.5);
});

for (const locale of LOCALES) {
	for (const scheme of ['light', 'dark'] as const) {
		test(`${locale} ${scheme}: Raw filters and results remain reachable by input on short screens @mobile-only`, async ({ page }, info) => {
			test.setTimeout(120_000);
			const logs = new SystemLogsPage(page);
			await logs.open({ locale, size: OPENING, touch: false, scheme });
			const session = await page.context().newCDPSession(page);
			const filters = page.getByTestId('raw-filters');
			const list = page.getByTestId('raw-scroller');
			const search = page.getByTestId('raw-search');
			const toggle = page.getByTestId('raw-filters-toggle');
			const view = page.getByTestId('system-logs-view');
			const tabs = view.getByRole('tab');
			const raw = tabs.nth(1);
			const outerScroll = () => view.evaluate((el) => el.scrollTop);
			for (const size of SIZES) {
				for (const expanded of [true, false]) {
					const name = `${size.width}x${size.height} ${expanded ? 'open' : 'closed'}`;
					await test.step(name, async () => {
						await page.setViewportSize(OPENING);
						await tabs.first().click();
						await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
						await logs.show('raw');
						if (expanded) await toggle.click();
						await raw.focus();
						await page.keyboard.press('Tab');
						await expect(filters.getByRole('radio', { checked: true }).first()).toBeFocused();
						await page.keyboard.press('Tab');
						await expect(search).toBeFocused();
						await page.setViewportSize(size);
						await logs.settle();
						await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
						await expect(search).toBeFocused();

						const original = await region(list);
						const focus = await region(search);
						await info.attach(name, { body: JSON.stringify({ original, focus }), contentType: 'application/json' });
						expect.soft(original.height, `${name}: allocated Raw results: ${JSON.stringify(original)}`).toBeGreaterThanOrEqual(88);
						expect.soft(focus.visible + 0.5, `${name}: focused Search is visible after resizing`).toBeGreaterThanOrEqual(focus.boxHeight);
						if (size.height === 260) {
							expect.soft(original.visible, `${name}: Raw results visible with Search focused`).toBeGreaterThanOrEqual(87.5);
						}
						if (original.height < 88 || focus.visible + 0.5 < focus.boxHeight) return;
						expect(original.content).toBeGreaterThan(original.height);

						if (size.height === 260) {
							// Focus relief must not hide the toolbar behind a scroll trap. From
							// inside the filters, wheel through their top edge into the outer view.
							const before = await outerScroll();
							expect(before).toBeGreaterThan(0);
							for (let n = 0; n < 3 && (await outerScroll()) === before; n++) {
								const from = await region(filters);
								expect(from.hit).toBe(true);
								await page.mouse.move(from.x, from.y);
								await page.mouse.wheel(0, -45);
								await settleScroll(filters);
							}
							expect(await outerScroll(), `${name}: wheel escapes the filters`).toBeLessThan(before);
						}

						// Start with a touch swipe over visible filters, not a scripted scroll.
						const first = await region(filters);
						expect(first.hit).toBe(true);
						if (first.remaining >= 20) {
							await swipe(session, first, -40);
							await expect.poll(async () => (await region(filters)).offsets).not.toEqual(first.offsets);
							await settleScroll(filters);
						}
						// Wheel across the bottom boundary of the filter region, if necessary.
						for (let n = 0; n < 5 && (await region(list)).visible < 87.5; n++) {
							const from = await region(filters);
							expect(from.hit).toBe(true);
							await page.mouse.move(from.x, from.y);
							await page.mouse.wheel(0, 500);
							await expect.poll(async () => (await region(filters)).offsets, `${name}: wheel chains out of filters`).not.toEqual(from.offsets);
							await settleScroll(filters);
						}
						const results = await region(list);
						expect(results.visible, `${name}: readable results reachable by input`).toBeGreaterThanOrEqual(87.5);
						expect(results.hit).toBe(true);
						await expect(list.getByTestId('raw-row').first()).toBeInViewport();
						await page.mouse.move(results.x, results.y);
						await page.mouse.wheel(0, 65);
						await expect.poll(async () => (await region(list)).scroll).toBeGreaterThan(results.scroll);
						await settleScroll(list);
						const moved = await region(list);
						await swipe(session, moved, 36);
						await expect.poll(async () => (await region(list)).scroll).toBeLessThan(moved.scroll);
						await settleScroll(list);
					});
				}
			}
		});
	}
}
