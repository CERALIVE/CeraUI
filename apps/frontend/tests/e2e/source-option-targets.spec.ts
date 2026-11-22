import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, type PageRpc, test } from './fixtures/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { ensureAuthenticated, navigateTo, setLocale } from './helpers/index.js';

/**
 * A source option holds its select button and its "?" help side by side in one
 * frame, so their hit areas must never overlap: a tap meant for one would land
 * on the other. In touch layout a help button's ::after overlay grows its hit
 * area, which is exactly how the overlap used to appear at the 1024x600 kiosk.
 *
 * The socket is proxied so a select tap is SEEN (its `setConfig` is recorded)
 * but never sent: the worker backend's saved source stays untouched. A selected
 * option is pushed to the page instead, so its summary and How to publish are
 * measured too.
 */

type Box = { left: number; right: number; top: number; bottom: number };
type Target = { name: string; help: boolean; box: Box };

const MIN = 43.5;
// DESIGN.md TT-2 / live-screen.md: neighbouring targets keep 8 px apart.
const CLEARANCE = 7.5;

function gap(a: Box, b: Box): number {
	return Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
}

async function proxy(page: Page, pageRpc: PageRpc, sent: string[]): Promise<{ ws?: WebSocketRoute }> {
	const live: { ws?: WebSocketRoute } = {};
	await page.routeWebSocket(isBackendSocket, (ws) => {
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);
		live.ws = ws;
		ws.onMessage((message) => {
			if (typeof message === 'string' && message.includes('setConfig')) {
				sent.push(message);
				return;
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
	const network = page.locator('li[data-origin="network"]').first();
	await expect(network).toBeVisible({ timeout: 20_000 });
	const id = ((await network.getAttribute('data-testid')) ?? '').replace('source-row-', '');
	live.ws?.send(JSON.stringify({ config: { source: id } }));
	await expect(network).toHaveAttribute('data-selected', 'true');
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
						box,
					};
				});
		}
		return out;
	});
}

function problems(targets: Record<string, Target[]>, label: string): string[] {
	const found: string[] = [];
	for (const [row, controls] of Object.entries(targets)) {
		for (const help of controls.filter((control) => control.help)) {
			const width = help.box.right - help.box.left;
			const height = help.box.bottom - help.box.top;
			if (Math.min(width, height) < MIN) found.push(`${label} ${row} ${help.name}: ${Math.round(width)}x${Math.round(height)}`);
			for (const other of controls) {
				if (other === help) continue;
				const x = Math.min(help.box.right, other.box.right) - Math.max(help.box.left, other.box.left);
				const y = Math.min(help.box.bottom, other.box.bottom) - Math.max(help.box.top, other.box.top);
				if (x > 0.5 && y > 0.5) {
					found.push(`${label} ${row} ${help.name} overlaps ${other.name} by ${Math.round(x)}x${Math.round(y)}`);
				} else if (gap(help.box, other.box) < CLEARANCE) {
					found.push(`${label} ${row} ${help.name} is ${Math.round(gap(help.box, other.box))} px from ${other.name}`);
				}
			}
		}
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
	test(`no option help overlaps another control, at every width and in touch, ${locale}`, { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
		test.setTimeout(180_000);
		const live = await proxy(page, pageRpc, []);
		const found: string[] = [];
		let measured = 0;
		await page.setViewportSize(WIDTHS[0]);
		await openLive(page, live, { locale, touch: false });
		for (const viewport of WIDTHS) {
			await page.setViewportSize(viewport);
			const targets = await rowTargets(page);
			measured += Object.values(targets).flat().filter((control) => control.help).length;
			found.push(...problems(targets, `${viewport.width}`));
		}
		await page.setViewportSize(WIDTHS[1]);
		await openLive(page, live, { locale, touch: true });
		await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'touch');
		for (const viewport of [WIDTHS[1], KIOSK]) {
			await page.setViewportSize(viewport);
			const targets = await rowTargets(page);
			measured += Object.values(targets).flat().filter((control) => control.help).length;
			found.push(...problems(targets, `${viewport.width}x${viewport.height} touch`));
		}
		expect(measured, 'the options carry help buttons to measure').toBeGreaterThan(5);
		expect(found).toEqual([]);
	});
}

for (const condition of [
	{ name: '1024x600 touch', viewport: KIOSK, touch: true },
	{ name: '375 touch', viewport: WIDTHS[1], touch: true },
	{ name: '375 phone', viewport: WIDTHS[1], touch: false },
]) {
	test(`a tap beside an option's help selects it, and a tap on the help opens it, ${condition.name}`, { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
		test.setTimeout(120_000);
		const sent: string[] = [];
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
		const selectBox = (await row.locator('[data-select]').boundingBox()) ?? undefined;
		if (!helpBox || !selectBox) throw new Error('option targets not measured');
		const selectEdges = { left: selectBox.x, right: selectBox.x + selectBox.width, top: selectBox.y, bottom: selectBox.y + selectBox.height };
		expect(gap(selectEdges, helpBox), 'clearance between Select and Help').toBeGreaterThanOrEqual(CLEARANCE);
		expect(Math.min(selectBox.height, helpBox.right - helpBox.left, helpBox.bottom - helpBox.top)).toBeGreaterThanOrEqual(MIN);
		const y = Math.min(Math.max((helpBox.top + helpBox.bottom) / 2, selectBox.y + 4), selectBox.y + selectBox.height - 4);

		// Just inside the select button, at its edge facing the help (left to right).
		await page.mouse.click(selectBox.x + selectBox.width - 4, y);
		await expect.poll(() => sent.some((frame) => frame.includes(`"${id}"`)), { message: 'the tap selected the option' }).toBe(true);
		await expect(help).toHaveAttribute('aria-expanded', 'false');

		// Just inside the help's hit area, at its edge facing the select button.
		const before = sent.length;
		await page.mouse.click(helpBox.left + 4, y);
		await expect(help).toHaveAttribute('aria-expanded', 'true');
		expect(sent.length, 'the help tap selected nothing').toBe(before);
		await page.keyboard.press('Escape');
	});
}
