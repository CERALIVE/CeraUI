import fs from 'node:fs';
import path from 'node:path';

import type { CDPSession } from '@playwright/test';

import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { expect, test } from './fixtures/index.js';
import { runAxe } from './helpers/axe.js';
import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from './helpers/index.js';
import { type Audited, type Scheme, SYSTEM_LOGS_DIALOG, SystemLogsPage } from './pages/system-logs.js';

/**
 * System Logs responsive, locale, touch, reduced-motion and live-region checks.
 * The audits live in helpers/system-logs-audit.ts and helpers/system-logs-paint.ts.
 */

const OUT = path.join(EVIDENCE_DIR, 'system-logs-responsive');
const SIZES = [
	{ width: 375, height: 812 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 600 },
] as const;
const LOCALES = ['en', 'ar', 'de'] as const;
const ALL_LOCALES = ['en', 'es', 'de', 'fr', 'pt-BR', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;
const NARROW = [
	{ width: 320, height: 720 },
	{ width: 375, height: 812 },
] as const;

type Box = { readonly left: number; readonly right: number } | null;

interface Geometry {
	readonly dir: string;
	readonly covered: { readonly dialog: number; readonly viewport: number };
	readonly header: Box;
	readonly title: Box;
	readonly close: Box;
	readonly side: Box;
	readonly tabs: readonly Box[];
	readonly rawText: readonly string[];
}

/** Direction and dialog-width findings for one System Logs geometry snapshot. */
function mirrorFindings(geometry: Geometry, rtl: boolean, wide: boolean): string[] {
	const found: string[] = [];
	const { header, title, close, side, tabs } = geometry;
	const [first, second] = tabs;
	if (geometry.dir !== (rtl ? 'rtl' : 'ltr')) found.push(`the document direction is "${geometry.dir}"`);
	const { dialog, viewport } = geometry.covered;
	if (Math.abs(dialog - viewport) > 0.5) found.push(`the full-viewport view is ${dialog} px wide in a ${viewport} px viewport`);
	if (geometry.rawText.length === 0) found.push('no raw log text rendered to check its direction');
	for (const text of geometry.rawText) if (text !== 'ltr/ltr') found.push(`raw log text is ${text}, not ltr`);
	if (!header || !title || !close || !first || !second) return [...found, 'the dialog header or its tabs did not render'];
	const middle = (header.left + header.right) / 2;
	const closeAtEnd = rtl ? close.right < middle && close.right <= title.left + 0.5 : close.left > middle && close.left >= title.right - 0.5;
	if (!closeAtEnd) found.push(`the close button (${close.left}-${close.right}) is not at the inline end of the title (${title.left}-${title.right})`);
	if (rtl ? first.left <= second.left : first.left >= second.left) found.push('the first tab does not start at the inline start');
	if (wide) {
		const sideAtEnd = side !== null && (rtl ? side.right <= first.left + 0.5 : side.left >= first.right - 0.5);
		if (!sideAtEnd) found.push('the side column is not at the inline end of the tabs');
	}
	return found;
}

function writeEvidence(file: string, body: unknown): void {
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(body, null, 1)}\n`, 'utf8');
}

function schemeFor(...indexes: number[]): Scheme {
	return indexes.reduce((sum, index) => sum + index, 0) % 2 === 0 ? 'dark' : 'light';
}

const findings = (audits: readonly Audited[]) => audits.flatMap((audit) => audit.found.map((finding) => `${audit.state}: ${finding}`));

test.beforeEach(({ browserName }) => {
	test.skip(browserName !== 'chromium', 'painted-geometry probes are Chromium-specific');
});

for (const [sizeIndex, size] of SIZES.entries()) {
	for (const [localeIndex, locale] of LOCALES.entries()) {
		const touch = size.width === 1024 && size.height === 600;
		const scheme = schemeFor(sizeIndex, localeIndex);
		test(`${locale} at ${size.width}x${size.height}${touch ? ' touch' : ''} ${scheme}: System Logs fits, mirrors and stays reachable`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			const wide = size.width >= 1024;
			const logs = new SystemLogsPage(page);
			const audits: Audited[] = [];
			const axe: { state: string; violations: unknown[] }[] = [];
			const failures: string[] = [];
			let geometry: Geometry | undefined;
			try {
				await logs.open({ locale, size, touch, scheme });
				audits.push(...(await logs.auditViews({ locale, touch, tabLines: 2 })));
				if (touch) {
					await logs.show('raw');
					await page.getByTestId('raw-filters-toggle').click();
					audits.push(await logs.auditListbox(page.getByTestId('raw-sources'), 'raw-source-options', locale));
					audits.push(await logs.auditListbox(page.getByTestId('raw-time'), 'raw-time-options', locale));
					await logs.show('storage');
					audits.push(await logs.auditListbox(page.getByTestId('storage-maxAgeDays-select'), 'retention-options', locale));
					audits.push(await logs.auditListbox(page.getByTestId('storage-maxSizeMb-select'), 'size-limit-options', locale));
				}
				failures.push(...findings(audits));
				for (const view of ['events', 'raw', 'storage'] as const) {
					await logs.show(view);
					const violations = await runAxe(page, { include: [SYSTEM_LOGS_DIALOG] });
					axe.push({ state: view, violations });
					failures.push(...violations.map((violation) => `${view}: axe ${violation.id} on ${violation.targets.join(', ')}`));
				}
				await logs.show('raw');
				geometry = await page.locator(SYSTEM_LOGS_DIALOG).evaluate((dialog) => {
					const box = (el: Element | null) => {
						const rect = el?.getBoundingClientRect();
						return rect === undefined ? null : { left: rect.left, right: rect.right };
					};
					const texts = dialog.querySelectorAll<HTMLElement>('[data-testid="raw-row-message"], [data-testid="raw-row-unit"]');
					return {
						dir: document.documentElement.dir,
						covered: { dialog: dialog.getBoundingClientRect().width, viewport: window.innerWidth },
						header: box(dialog.querySelector('[data-app-dialog-header]')),
						title: box(dialog.querySelector('[data-dialog-title]')),
						close: box(dialog.querySelector('[data-testid="app-dialog-close"]')),
						side: box(dialog.querySelector('[data-testid="system-logs-side"]')),
						tabs: [...dialog.querySelectorAll('[role="tab"]')].map((tab) => box(tab)),
						rawText: [...texts].map((el) => `${el.getAttribute('dir')}/${getComputedStyle(el).direction}`),
					};
				});
				failures.push(...mirrorFindings(geometry, locale === 'ar', wide));
			} finally {
				writeEvidence(`${locale}-${size.width}x${size.height}${touch ? '-touch' : ''}-${scheme}.json`, {
					locale,
					size,
					touch,
					scheme,
					geometry,
					audits,
					axe,
				});
			}
			expect(failures).toEqual([]);
		});
	}
}

for (const [sizeIndex, size] of NARROW.entries()) {
	for (const [localeIndex, locale] of ALL_LOCALES.entries()) {
		const scheme = schemeFor(sizeIndex, localeIndex);
		test(`${locale} at ${size.width} px ${scheme}: every System Logs label is painted whole inside its control`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			const logs = new SystemLogsPage(page);
			const audits: Audited[] = [];
			try {
				await logs.open({ locale, size, touch: false, scheme });
				audits.push(...(await logs.auditViews({ locale, touch: false, tabLines: 2 })));
			} finally {
				writeEvidence(`narrow-${locale}-${size.width}-${scheme}.json`, { locale, size, scheme, audits });
			}
			expect(findings(audits)).toEqual([]);
		});
	}
}

test('an ordinary dialog keeps the page scrollbar gutter that the fullscreen view drops', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	const gutter = () => page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter);
	await page.getByTestId('settings-entry-versions').click();
	await expect(page.getByTestId('app-dialog-close')).toBeVisible();
	expect(await gutter()).toBe('stable');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.getByTestId('settings-entry-logs').click();
	await expect(page.getByTestId('system-logs-view')).toBeVisible();
	expect(await gutter()).toBe('auto');
});

for (const touch of [false, true]) {
	const min = touch ? 44 : 24;
	test(`View logs actions are ${min} px targets with their label painted inside ${touch ? 'in touch layout' : 'outside touch layouts'}`, async ({
		page,
		pageRpc,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(touch ? '/?mode=touch' : '/');
		await ensureAuthenticated(page);
		const notice = {
			name: 'responsive-pointer',
			type: 'error',
			msg: 'Stream failed',
			key: 'notifications.streamStartInternalFailed',
			is_dismissable: true,
			is_persistent: true,
			duration: 0,
		};
		await pageRpc.call(['dev', 'emit'], { type: 'notification', payload: { show: [notice] } });
		await pageRpc.call(['dev', 'emit'], {
			type: 'notification',
			payload: { show: [{ ...notice, name: 'responsive-toast', is_persistent: false, duration: 60 }] },
		});
		const actions = {
			notice: page.locator('[data-testid="persistent-notice"][data-notification="responsive-pointer"] [data-testid="view-logs-action"]'),
			toast: page.locator('[data-sonner-toast] [data-button]'),
		};
		const measured: Record<string, unknown> = {};
		for (const [surface, action] of Object.entries(actions)) {
			await expect(action).toBeVisible();
			await new SystemLogsPage(page).settle();
			const value = await action.evaluate((el) => {
				const box = el.getBoundingClientRect();
				const range = document.createRange();
				range.selectNodeContents(el);
				const runs = [...range.getClientRects()].filter((rect) => rect.width > 0);
				const inside = runs.every(
					(run) => run.left >= box.left - 0.5 && run.right <= box.right + 0.5 && run.top >= box.top - 1 && run.bottom <= box.bottom + 1,
				);
				return { width: box.width, height: box.height, inside, font: getComputedStyle(el).fontFamily };
			});
			measured[surface] = value;
			expect(value.width, `${surface} View logs width`).toBeGreaterThanOrEqual(min - 0.5);
			expect(value.height, `${surface} View logs height`).toBeGreaterThanOrEqual(min - 0.5);
			expect(value.inside, `${surface} View logs label leaves its control`).toBe(true);
		}
		writeEvidence(`view-logs-actions-${touch ? 'touch' : 'pointer'}.json`, measured);
	});
}

test('reduced motion keeps the follow states present, still and textually distinct', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const logs = new SystemLogsPage(page);
	await logs.open({ locale: 'en', size: { width: 375, height: 812 }, touch: false, scheme: 'dark' });
	await logs.show('raw');
	const button = page.getByTestId('raw-follow-button');
	const state = page.getByTestId('raw-follow-state');
	const animated = () =>
		page
			.locator(SYSTEM_LOGS_DIALOG)
			.evaluate((dialog) =>
				[...dialog.querySelectorAll('*')]
					.filter((el) => getComputedStyle(el).animationName !== 'none')
					.map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`),
			);

	await button.click();
	await expect(state).toHaveAttribute('data-state', 'following');
	await expect(state).toHaveText(en['systemLogs.follow.following']);
	expect(await animated(), 'an element in System Logs animates under reduced motion').toEqual([]);

	await button.click();
	await expect(state).toHaveAttribute('data-state', 'paused');
	await expect(state).toHaveText(en['systemLogs.follow.paused']);
	expect(en['systemLogs.follow.paused']).not.toBe(en['systemLogs.follow.following']);

	await button.click();
	await expect(state).toHaveAttribute('data-state', 'following');
	// Check that the Following dot has an animation name in `no-preference` mode.
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	expect(await state.locator('[data-follow-dot]').evaluate((dot) => getComputedStyle(dot).animationName)).not.toBe('none');
});

test('one polite status region announces each follow state exactly once', async ({ page, pageRpc }) => {
	// Drop server string messages that contain the quoted logs.follow token and lack the quoted id token.
	// Observe the resulting follow-state text mutations. raw-view.test.ts covers the throttled new-entry summary.
	await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
		const server = socket.connectToServer();
		pageRpc.bindConnectionLifecycle(socket, server);
		socket.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			if (typeof message === 'string' && message.includes('"logs.follow"') && !message.includes('"id"')) return;
			socket.send(message);
			pageRpc.acceptServerMessage(message);
		});
	});
	const logs = new SystemLogsPage(page);
	await logs.open({ locale: 'en', size: { width: 1280, height: 800 }, touch: false, scheme: 'dark' });
	await logs.show('raw');
	const region = page.getByTestId('raw-status');
	await expect(region).toHaveAttribute('role', 'status');
	await expect(region).toHaveAttribute('aria-live', 'polite');
	await expect(region).toHaveText('');
	await region.evaluate((el) => {
		const spoken: string[] = [];
		Object.assign(window, { __rawSpoken: spoken });
		new MutationObserver(() => spoken.push(el.textContent ?? '')).observe(el, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	});
	const spoken = () => page.evaluate(() => (window as unknown as { __rawSpoken: string[] }).__rawSpoken);
	const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const button = page.getByTestId('raw-follow-button');
	const state = page.getByTestId('raw-follow-state');
	const expected: string[] = [];
	for (const [next, key] of [
		['following', 'systemLogs.announce.following'],
		['paused', 'systemLogs.announce.paused'],
		['following', 'systemLogs.announce.resumed'],
	] as const) {
		await button.click();
		await expect(state).toHaveAttribute('data-state', next);
		expected.push(en[key]);
		await expect.poll(spoken).toEqual(expected);
		await frames();
		expect(await spoken()).toEqual(expected);
	}
});

test('Japanese renders in a resolved CJK font without missing glyphs', async ({ page }) => {
	const logs = new SystemLogsPage(page);
	await logs.open({ locale: 'ja', size: { width: 375, height: 812 }, touch: false, scheme: 'dark' });
	await logs.show('events');
	const audit = await logs.audit('events', { locale: 'ja', touch: false });
	expect(audit.found.filter((finding) => finding.includes('missing glyph'))).toEqual([]);
	const session: CDPSession = await page.context().newCDPSession(page);
	const { root } = await session.send('DOM.getDocument', { depth: -1 });
	await session.send('CSS.enable');
	const tab = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="system-logs-view"] [role="tab"]' });
	const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId: tab.nodeId });
	writeEvidence('ja-fonts.json', { audit: audit.fonts, platform: fonts });
	const label = await page.getByTestId('system-logs-view').getByRole('tab').first().innerText();
	const cjk = fonts.filter((font) => !/Space Grotesk|JetBrains Mono/i.test(font.familyName));
	expect(cjk.length, `the Japanese tab label resolved only to ${fonts.map((font) => font.familyName).join(', ')}`).toBeGreaterThan(0);
	expect(cjk.reduce((sum, font) => sum + font.glyphCount, 0)).toBeGreaterThanOrEqual([...label].length);
});

for (const scheme of ['dark', 'light'] as const) {
	test(`${scheme}: the Clear confirmations keep their labels at AA at rest, on hover and on keyboard focus`, async ({ page }) => {
		test.setTimeout(120_000);
		const logs = new SystemLogsPage(page);
		const audits: Audited[] = [];
		try {
			await logs.open({ locale: 'en', size: { width: 1440, height: 900 }, touch: false, scheme });
			await logs.show('storage');
			for (const [trigger, confirm] of [
				['systemLogs.storage.clearAll', 'systemLogs.storage.clearAllConfirm'],
				['systemLogs.storage.clearEvents', 'systemLogs.storage.clearEventsConfirm'],
			] as const) {
				await page.getByRole('button', { name: en[trigger], exact: true }).click();
				const dialog = page.getByRole('alertdialog');
				const action = dialog.getByRole('button', { name: en[confirm], exact: true });
				await expect(action).toBeVisible();
				await logs.settle();
				const audit = async (state: string) => {
					const result = await logs.audit(`${trigger}-${state}`, { locale: 'en', touch: false, portals: ['[role="alertdialog"]'] });
					audits.push(result);
					expect(result.contrast.map((entry) => entry.name)).toContain(`button "${en[confirm]}"`);
				};
				await audit('rest');
				await action.hover();
				await logs.settle();
				await audit('hover');
				await page.mouse.move(0, 0);
				// The dialog opens on Cancel; Tab moves keyboard focus to the action.
				await page.keyboard.press('Tab');
				await expect(action).toBeFocused();
				await logs.settle();
				await audit('focus');
				await page.keyboard.press('Escape');
				await expect(dialog).toHaveCount(0);
			}
		} finally {
			writeEvidence(`clear-confirm-${scheme}.json`, audits);
		}
		expect(findings(audits)).toEqual([]);
	});
}

for (const locale of ALL_LOCALES) {
	test(`${locale}: the Raw search placeholder is painted whole and the field keeps its full name`, async ({ page }) => {
		test.setTimeout(120_000);
		const logs = new SystemLogsPage(page);
		const measured: { size: string; name: string | null; placeholder: string; width: number; room: number }[] = [];
		try {
			for (const [size, touch] of [
				[{ width: 320, height: 720 }, false],
				[{ width: 390, height: 844 }, false],
				[{ width: 1440, height: 900 }, false],
				// Touch layout persists across loads, so the touch kiosk comes last.
				[{ width: 1024, height: 600 }, true],
			] as const) {
				await logs.open({ locale, size, touch, scheme: 'dark' });
				await logs.show('raw');
				const fit = await page.getByTestId('raw-search').evaluate((input: HTMLInputElement) => {
					const style = getComputedStyle(input);
					const ctx = document.createElement('canvas').getContext('2d');
					if (ctx === null) throw new Error('Chromium gave no 2D canvas context');
					ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
					ctx.letterSpacing = style.letterSpacing;
					return {
						name: input.getAttribute('aria-label'),
						placeholder: input.placeholder,
						width: ctx.measureText(input.placeholder).width,
						room: ['borderLeftWidth', 'paddingLeft', 'paddingRight', 'borderRightWidth'].reduce(
							(room, side) => room - Number.parseFloat(style.getPropertyValue(side.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))),
							input.getBoundingClientRect().width,
						),
					};
				});
				measured.push({ size: `${size.width}x${size.height}`, ...fit });
			}
		} finally {
			writeEvidence(`raw-search-placeholder-${locale}.json`, measured);
		}
		expect(measured.filter((entry) => entry.width > entry.room + 0.5)).toEqual([]);
		expect(new Set(measured.map((entry) => entry.name)).size).toBe(1);
		// The wide layout has room for the full label, so it stays the placeholder there.
		const wide = measured.find((entry) => entry.size === '1440x900');
		expect(wide?.placeholder).toBe(wide?.name);
	});
}

for (const scheme of ['dark', 'light'] as const) {
	test(`ar ${scheme}: every Storage size reads its value before its Latin unit`, async ({ page }) => {
		test.setTimeout(120_000);
		const logs = new SystemLogsPage(page);
		await logs.open({ locale: 'ar', size: { width: 390, height: 844 }, touch: false, scheme });
		await logs.show('storage');
		const order = () =>
			page.evaluate(() => {
				const sizes: { text: string; valueFirst: boolean }[] = [];
				const roots = document.querySelectorAll('[data-testid="system-logs-storage"], [data-slot="select-content"]');
				for (const root of roots) {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
					for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
						for (const match of (node.textContent ?? '').matchAll(/(\d[\d.,]*)\u00a0([KMGT]?B)(?![A-Za-z])/g)) {
							const at = (start: number, end: number) => {
								const range = document.createRange();
								range.setStart(node, start);
								range.setEnd(node, end);
								return range.getBoundingClientRect();
							};
							const unitAt = match.index + match[0].length - (match[2]?.length ?? 0);
							const value = at(match.index, match.index + (match[1]?.length ?? 0));
							const unit = at(unitAt, unitAt + (match[2]?.length ?? 0));
							sizes.push({ text: match[0], valueFirst: value.left < unit.left });
						}
					}
				}
				return sizes;
			});
		const readouts = await order();
		await page.getByTestId('storage-maxSizeMb-select').click();
		await expect(page.locator('[data-slot="select-content"]').getByRole('option')).not.toHaveCount(0);
		await logs.settle();
		const menu = (await order()).slice(readouts.length);
		writeEvidence(`ar-storage-sizes-${scheme}.json`, { readouts, menu });
		// The usage sentence, the event history, the volume table, the size limit and its options.
		expect(readouts.length).toBeGreaterThanOrEqual(4);
		expect(menu.length).toBeGreaterThanOrEqual(2);
		expect([...readouts, ...menu].filter((size) => !size.valueFirst)).toEqual([]);
	});
}
