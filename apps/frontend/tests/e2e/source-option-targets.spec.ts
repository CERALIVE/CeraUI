import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, type PageRpc, test } from './fixtures/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { ensureAuthenticated, navigateTo, setLocale } from './helpers/index.js';

/**
 * A source option holds its select button and its "?" help side by side in one
 * frame, so their hit areas must never overlap or touch: a tap meant for one
 * would land on the other. In touch layout a help button's ::after overlay grows
 * its hit area, which is how the overlap first appeared at the 1024x600 kiosk.
 *
 * The socket is proxied so a select tap is SEEN (its `streaming.setConfig` is
 * recorded) but never sent: the worker backend's saved source stays untouched.
 * A selected option is pushed to the page instead, so its summary and its open
 * How to publish are measured too.
 */

type Box = { left: number; right: number; top: number; bottom: number };
type Target = { name: string; help: boolean; select: boolean; box: Box };

// DESIGN.md TT-1/TT-2 and live-screen.md: 44 px targets, 8 px between neighbours.
const MIN = 44 - 0.01;
const CLEARANCE = 8 - 0.01;
const WITH_HELP = ['source-row-rtmp', 'source-row-srt'];
const WITHOUT_HELP = ['source-row-test'];

function gap(a: Box, b: Box): number {
	return Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
}

async function proxy(page: Page, pageRpc: PageRpc, sent: unknown[]): Promise<{ ws?: WebSocketRoute }> {
	const live: { ws?: WebSocketRoute } = {};
	await page.routeWebSocket(isBackendSocket, (ws) => {
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);
		live.ws = ws;
		ws.onMessage((message) => {
			if (typeof message === 'string') {
				try {
					const frame = JSON.parse(message) as { path?: unknown };
					if (Array.isArray(frame.path) && frame.path.join('.') === 'streaming.setConfig') {
						sent.push(frame);
						return;
					}
				} catch {
					// Not JSON: forward it untouched.
				}
			}
			server.send(message);
		});
		server.onMessage((message) => {
			pageRpc.acceptServerMessage(message);
			ws.send(message);
		});
	});
	return live;
}

/** Opens Live in a locale and layout, pushes a selected ingest option and opens its How to publish. */
async function openLive(
	page: Page,
	live: { ws?: WebSocketRoute },
	options: { locale: string; touch: boolean },
): Promise<string> {
	const url = options.touch ? '/?mode=touch' : '/';
	await page.goto(url);
	await ensureAuthenticated(page);
	await setLocale(page, options.locale);
	await page.goto(url);
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
	await expect(page.locator('html')).toHaveAttribute('lang', options.locale);
	await expect(page.locator('html')).toHaveAttribute('dir', options.locale === 'ar' ? 'rtl' : 'ltr');
	if (options.touch) await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'touch');
	const network = page.locator('li[data-origin="network"]').first();
	await expect(network).toBeVisible({ timeout: 20_000 });
	const id = ((await network.getAttribute('data-testid')) ?? '').replace('source-row-', '');
	live.ws?.send(JSON.stringify({ config: { source: id } }));
	await expect(network).toHaveAttribute('data-selected', 'true');
	await network.locator('[data-testid^="source-network-ingest-instructions-toggle-"]').click();
	await expect(network.locator('details')).toHaveAttribute('open', '');
	return id;
}

/** Every visible control of every source option, with the hit area it answers to. */
async function rowTargets(page: Page): Promise<Record<string, Target[]>> {
	return page.evaluate(() => {
		const px = (value: string): number => Number.parseFloat(value) || 0;
		const out: Record<string, Target[]> = {};
		for (const row of document.querySelectorAll<HTMLElement>('li[data-testid^="source-row-"]')) {
			out[row.dataset.testid ?? ''] = [
				...row.querySelectorAll<HTMLElement>('button, summary, a[href], [role="radio"]'),
			]
				.filter((element) => element.getClientRects().length > 0)
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					const after = getComputedStyle(element, '::after');
					const box = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
					// Physical insets, so the overlay is read correctly right to left too.
					if (after.position === 'absolute' && after.content !== 'none') {
						box.left = Math.min(box.left, rect.left + px(style.borderLeftWidth) + px(after.left));
						box.right = Math.max(box.right, rect.right - px(style.borderRightWidth) - px(after.right));
						box.top = Math.min(box.top, rect.top + px(style.borderTopWidth) + px(after.top));
						box.bottom = Math.max(box.bottom, rect.bottom - px(style.borderBottomWidth) - px(after.bottom));
					}
					return {
						name: element.dataset.testid ?? (element.textContent ?? '').trim().slice(0, 30),
						help: element.dataset.touchTarget === 'hit-area',
						select: element.hasAttribute('data-select'),
						box,
					};
				});
		}
		return out;
	});
}

/** Options with no help or switch beside their select: the space the select leaves, and its title's line count. */
async function helpless(page: Page): Promise<{ row: string; name: string; spare: number; lines: number }[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('li[data-testid^="source-row-"]')].flatMap((row) => {
			const header = row.firstElementChild;
			const select = header?.querySelector<HTMLElement>('[data-select]');
			const name = row.querySelector<HTMLElement>('[data-testid^="source-row-name-"]');
			if (!header || !select || !name) throw new Error(`${row.dataset.testid}: option header, select or name missing`);
			if (header.querySelector('button:not([data-select])')) return [];
			const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight) || 20;
			return [
				{
					row: row.dataset.testid ?? '',
					name: (name.textContent ?? '').trim(),
					spare: header.getBoundingClientRect().width - select.getBoundingClientRect().width,
					lines: Math.round(name.getBoundingClientRect().height / lineHeight),
				},
			];
		}),
	);
}

async function check(page: Page, label: string): Promise<string[]> {
	const found: string[] = [];
	const targets = await rowTargets(page);
	for (const row of WITH_HELP) {
		if (!targets[row]?.some((control) => control.help)) found.push(`${label} ${row} has no help to measure`);
	}
	for (const [row, controls] of Object.entries(targets)) {
		for (const control of controls.filter((each) => each.help || each.select)) {
			const width = control.box.right - control.box.left;
			const height = control.box.bottom - control.box.top;
			if (Math.min(width, height) < MIN) found.push(`${label} ${row} ${control.name}: ${width.toFixed(1)}x${height.toFixed(1)}`);
		}
		for (const help of controls.filter((control) => control.help)) {
			for (const other of controls) {
				if (other === help) continue;
				const x = Math.min(help.box.right, other.box.right) - Math.max(help.box.left, other.box.left);
				const y = Math.min(help.box.bottom, other.box.bottom) - Math.max(help.box.top, other.box.top);
				if (x > 0 && y > 0) {
					found.push(`${label} ${row} ${help.name} overlaps ${other.name} by ${Math.round(x)}x${Math.round(y)}`);
				} else if (gap(help.box, other.box) < CLEARANCE) {
					found.push(`${label} ${row} ${help.name} is ${gap(help.box, other.box).toFixed(1)} px from ${other.name}`);
				}
			}
		}
	}
	const without = await helpless(page);
	for (const row of WITHOUT_HELP) {
		if (!without.some((option) => option.row === row)) found.push(`${label} ${row} should have no help`);
	}
	// An option with no help reserves nothing for one: its select takes the row.
	for (const option of without) {
		if (option.spare > 0.5) found.push(`${label} ${option.row} reserves ${Math.round(option.spare)} px for a help it lacks`);
	}
	return found;
}

const WIDTHS = [
	{ width: 320, height: 640 },
	{ width: 375, height: 812 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 900 },
];
const KIOSK = { width: 1024, height: 600 };

for (const locale of ['en', 'ar', 'de']) {
	test(`no option help overlaps or crowds another control, at every width and in touch, ${locale}`, { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
		test.setTimeout(180_000);
		const live = await proxy(page, pageRpc, []);
		const found: string[] = [];
		for (const touch of [false, true]) {
			await page.setViewportSize(WIDTHS[1]);
			await openLive(page, live, { locale, touch });
			for (const viewport of touch ? [...WIDTHS, KIOSK] : WIDTHS) {
				await page.setViewportSize(viewport);
				found.push(...(await check(page, `${viewport.width}x${viewport.height}${touch ? ' touch' : ''}`)));
			}
		}
		expect(found).toEqual([]);
	});
}

for (const condition of [
	{ name: '1024x600 touch', viewport: KIOSK, touch: true },
	{ name: '375 touch', viewport: WIDTHS[1], touch: true },
	{ name: '375 phone', viewport: WIDTHS[1], touch: false },
]) {
	test.describe(() => {
		test.use({ hasTouch: condition.touch });
		test(`a tap beside an option's help selects it, and a tap on the help opens it, ${condition.name}`, { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
			test.setTimeout(120_000);
			const sent: unknown[] = [];
			const live = await proxy(page, pageRpc, sent);
			await page.setViewportSize(condition.viewport);
			const selected = await openLive(page, live, { locale: 'en', touch: condition.touch });

			// An option that is not selected and can be, with a help button beside its select.
			const row = page
				.locator(`li[data-testid^="source-row-"][data-selected="false"]`)
				.filter({ has: page.locator(':scope > :first-child [data-touch-target="hit-area"]') })
				.filter({ has: page.locator('[data-select]:not([disabled])') })
				.first();
			await expect(row).toBeVisible();
			const id = ((await row.getAttribute('data-testid')) ?? '').replace('source-row-', '');
			expect(id).not.toBe(selected);
			// Taps land only inside the viewport; the page's scroll padding keeps the row clear of the Live bar.
			await row.scrollIntoViewIfNeeded();
			const help = row.locator(':scope > :first-child [data-touch-target="hit-area"]').first();
			const targets = (await rowTargets(page))[`source-row-${id}`] ?? [];
			const helpBox = targets.find((target) => target.help)?.box;
			const selectBox = targets.find((target) => target.select)?.box;
			if (!helpBox || !selectBox) throw new Error('option targets not measured');
			expect(gap(selectBox, helpBox), 'clearance between Select and Help').toBeGreaterThanOrEqual(CLEARANCE);
			expect(Math.min(selectBox.right - selectBox.left, selectBox.bottom - selectBox.top), 'Select target').toBeGreaterThanOrEqual(MIN);
			expect(Math.min(helpBox.right - helpBox.left, helpBox.bottom - helpBox.top), 'Help target').toBeGreaterThanOrEqual(MIN);
			const y = (Math.max(selectBox.top, helpBox.top) + Math.min(selectBox.bottom, helpBox.bottom)) / 2;
			const tap = (x: number) => (condition.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));

			// Just inside the select button, at its edge facing the help (left to right).
			await tap(selectBox.right - 2);
			await expect
				.poll(() => sent.some((frame) => JSON.stringify(frame).includes(`"source":"${id}"`)), {
					message: 'the tap selected the option',
				})
				.toBe(true);
			await expect(help).toHaveAttribute('aria-expanded', 'false');

			// Just inside the help's hit area, at its edge facing the select button.
			const before = sent.length;
			await tap(helpBox.left + 2);
			await expect(help).toHaveAttribute('aria-expanded', 'true');
			expect(sent.length, 'the help tap selected nothing').toBe(before);
			await page.keyboard.press('Escape');
		});
	});
}

test('an option without help keeps the whole row, so its title stays on one line on a phone', { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
	test.setTimeout(120_000);
	const live = await proxy(page, pageRpc, []);
	await page.setViewportSize(WIDTHS[1]);
	await openLive(page, live, { locale: 'en', touch: false });
	const rode = (await helpless(page)).find((option) => option.name.startsWith('RØDE'));
	expect(rode, 'the RØDE camera is listed with no help beside it').toBeDefined();
	expect(rode?.spare).toBeLessThanOrEqual(0.5);
	expect(rode?.lines, `"${rode?.name}" fits one line at 375 px`).toBe(1);
});

for (const locale of ['en', 'de', 'ar']) {
	test(`on a 390x844 phone's first screen the capture-format heading and its help sit above the Live bar, ${locale}`, { tag: '@desktop-only' }, async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await setLocale(page, locale);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		await expect(page.locator('html')).toHaveAttribute('lang', locale);
		const help = page.getByTestId('source-mode-info-usb');
		await expect(help).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('li[data-testid^="source-row-"][data-selected="true"]'), 'nothing is selected yet').toHaveCount(0);
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
		const fold = await help.evaluate((element) => {
			const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
			const bar = document.querySelector('[data-testid="live-bar"]')?.getBoundingClientRect().top ?? innerHeight;
			// The format block's heading: its first words, whatever line holds the help.
			const heading = document.querySelector('[data-testid="source-modes-usb"] span')?.getBoundingClientRect();
			const icon = element.querySelector('svg')?.getBoundingClientRect();
			const box = element.getBoundingClientRect();
			const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			return {
				header,
				bar,
				heading: heading ? { top: heading.top, bottom: heading.bottom } : null,
				icon: icon ? { top: icon.top, bottom: icon.bottom } : null,
				box: { top: box.top, bottom: box.bottom },
				tapped: hit !== null && (hit === element || element.contains(hit)),
			};
		});
		expect(fold.heading, 'the capture-format heading is rendered').not.toBeNull();
		expect(fold.icon, 'the help draws its icon').not.toBeNull();
		expect(fold.heading?.top ?? Number.NEGATIVE_INFINITY, 'the heading starts under the header').toBeGreaterThanOrEqual(fold.header);
		expect(fold.heading?.bottom ?? Number.POSITIVE_INFINITY, 'the heading ends above the Live bar').toBeLessThanOrEqual(fold.bar);
		expect(fold.icon?.bottom ?? Number.POSITIVE_INFINITY, 'the help\'s icon ends above the Live bar').toBeLessThanOrEqual(fold.bar);
		expect(fold.tapped, 'a tap at the help\'s centre reaches the help').toBe(true);
		// Main shows this help's whole 44 px target above the bar only in Arabic, where
		// the rows above it are shorter; in English and German main's target already
		// reached 12 px under the bar.
		if (locale === 'ar') {
			expect(fold.box.top, 'the help\'s target starts under the header').toBeGreaterThanOrEqual(fold.header);
			expect(fold.box.bottom, 'the help\'s whole target ends above the Live bar').toBeLessThanOrEqual(fold.bar);
		}
	});
}
