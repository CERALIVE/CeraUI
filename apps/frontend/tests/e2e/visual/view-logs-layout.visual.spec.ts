import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures/index.js';
import { EVIDENCE_DIR, ensureAuthenticated } from '../helpers/index.js';
import { runAxe } from '../helpers/axe.js';

const LOCALES = ['en', 'es', 'de', 'fr', 'pt-BR', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;
const OUT = path.join(EVIDENCE_DIR, `view-logs-layout-${process.env.DLS35_LAYOUT_PHASE ?? 'after'}`);

for (const locale of LOCALES) {
	for (const width of [320, 375, 1024, 1280]) {
		for (const scheme of ['dark', 'light'] as const) {
			test(`${locale} ${width} ${scheme}: log messages keep words and 44 px actions @visual`, async ({ page, pageRpc }, testInfo) => {
				test.skip(testInfo.project.name !== 'desktop', 'this matrix supplies its own viewport');
				let refuseAround = false;
				const aroundIds = new Set<string>();
				await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
					const server = socket.connectToServer();
					pageRpc.bindConnectionLifecycle(socket, server);
					socket.onMessage(message => {
						server.send(message);
						if (typeof message !== 'string') return;
						const frame = JSON.parse(message);
						if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.around') aroundIds.add(frame.id);
					});
					server.onMessage(message => {
						if (refuseAround && typeof message === 'string') {
							const frame = JSON.parse(message);
							if (aroundIds.has(frame.id)) { frame.result = { ok: false, error: 'READ_FAILED' }; message = JSON.stringify(frame); }
						}
						socket.send(message);
						pageRpc.acceptServerMessage(message);
					});
				});
				await page.setViewportSize({ width, height: width === 1024 ? 600 : width === 1280 ? 800 : 812 });
				await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
				await page.addInitScript(({ locale, scheme }) => {
					localStorage.setItem('locale', JSON.stringify({ code: locale }));
					localStorage.setItem('mode-watcher-mode', scheme);
				}, { locale, scheme });
				await page.goto('/?mode=touch');
				await ensureAuthenticated(page);
				const notice = {
					name: 'layout-pointer', type: 'error', msg: 'Stream failed',
					key: 'notifications.streamStartInternalFailed',
					is_dismissable: true, is_persistent: true, duration: 0,
				};
				await pageRpc.call(['dev', 'emit'], { type: 'notification', payload: { show: [notice] } });
				const captures: string[] = [];
				const measurements: unknown[] = [];
				const failures: string[] = [];
				const probe = async (selector: string, state: string) => {
					const root = page.locator(selector);
					await expect(root).toBeVisible();
					await page.evaluate(async () => {
						await document.fonts.ready;
						await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)));
					});
					const value = await root.evaluate((root, { locale, state }) => {
						const bad: string[] = [];
						const canvas = document.createElement('canvas');
						canvas.width = canvas.height = 1;
						const ctx = canvas.getContext('2d');
						if (ctx === null) throw new Error('Chromium has no color conversion context');
						const rgba = (color: string) => {
							ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
							const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
							return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
						};
						const mix = (top: ReturnType<typeof rgba>, bottom: ReturnType<typeof rgba>) => ({
							r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
							b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
						});
						const light = (color: ReturnType<typeof rgba>) => {
							const channel = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
							return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
						};
						const contrasts = [...root.querySelectorAll<HTMLElement>('p, [data-title], [data-description], button')].filter(node => node.checkVisibility() && node.textContent?.trim()).map(node => {
							const ancestors: HTMLElement[] = [];
							for (let el: HTMLElement | null = node; el; el = el.parentElement) ancestors.unshift(el);
							let background = { r: 1, g: 1, b: 1, a: 1 };
							for (const el of ancestors) background = mix(rgba(getComputedStyle(el).backgroundColor), background);
							const style = getComputedStyle(node);
							const foreground = mix(rgba(style.color), background);
							const a = light(background), b = light(foreground), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
							if (ratio < 4.5) bad.push(`contrast ${ratio.toFixed(3)}: ${node.textContent?.trim()}`);
							if (node.hasAttribute('data-button') && Number.parseFloat(style.borderTopWidth) < 1) bad.push('toast action lost its outline');
							return { text: node.textContent, color: style.color, background: style.backgroundColor, ratio };
						});
						const buttons = [...root.querySelectorAll<HTMLElement>('button')].filter(node => node.checkVisibility());
						const targets = buttons.filter(node => state === 'raw-failure' || node.dataset.testid === 'view-logs-action' || node.hasAttribute('data-button'));
						const sizes = targets.map(node => {
							const b = node.getBoundingClientRect();
							if (b.width < 44 || b.height < 44) bad.push(`target ${b.width}x${b.height}`);
							const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
							for (let text = walker.nextNode(); text; text = walker.nextNode()) {
								if (!text.textContent?.trim()) continue;
								const range = document.createRange(); range.selectNodeContents(text);
								for (const run of range.getClientRects()) {
									if (run.left < b.left - 1 || run.right > b.right + 1 || run.top < b.top - 1 || run.bottom > b.bottom + 1) bad.push('painted action label leaves its control');
									for (const x of [run.left + 1, run.right - 1]) if (!node.contains(document.elementFromPoint(x, run.top + run.height / 2))) bad.push('painted action label is occluded');
								}
							}
							return { text: node.textContent, width: b.width, height: b.height };
						});
						const messages = [...root.querySelectorAll<HTMLElement>('p, [data-title], [data-description]')];
						const splits: string[] = [];
						if (['ja', 'ko', 'zh'].includes(locale)) for (const message of messages) {
							const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
							for (let text = walker.nextNode(); text; text = walker.nextNode()) {
								for (const part of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text.textContent ?? '')) {
									if (!part.isWordLike || part.segment.length < 2) continue;
									const range = document.createRange();
									range.setStart(text, part.index); range.setEnd(text, part.index + part.segment.length);
									if (new Set([...range.getClientRects()].map(b => Math.round(b.top))).size > 1) splits.push(part.segment);
								}
							}
						}
						for (let a = 0; a < targets.length; a++) for (let b = a + 1; b < targets.length; b++) {
							const x = targets[a]?.getBoundingClientRect(), y = targets[b]?.getBoundingClientRect();
							if (x && y && Math.max(x.top, y.top) < Math.min(x.bottom, y.bottom)) {
								const gap = Math.max(x.left, y.left) - Math.min(x.right, y.right);
								if (gap < 8) bad.push(`action gap ${gap}`);
							} else if (x && y && Math.max(x.left, y.left) < Math.min(x.right, y.right)) {
								const gap = Math.max(x.top, y.top) - Math.min(x.bottom, y.bottom);
								if (gap < 8) bad.push(`wrapped action gap ${gap}`);
							}
						}
						return { bad, splits, sizes, contrasts, lang: document.documentElement.lang, dir: document.documentElement.dir, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' };
					}, { locale, state });
					const file = path.join(OUT, `${locale}-${width}-${scheme}-${state}.png`);
					fs.mkdirSync(OUT, { recursive: true });
					await page.screenshot({ path: file });
					captures.push(file); measurements.push({ state, ...value });
					failures.push(...value.bad.map(reason => `${state}: ${reason}`), ...value.splits.map(word => `${state}: split ${word}`));
					expect(value.lang).toBe(locale);
					expect(value.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
					expect(value.theme).toBe(scheme);
					if (['en', 'ar', 'ja'].includes(locale) && [375, 1280].includes(width)) {
						const axe = await runAxe(page, { include: [selector] });
						measurements.push({ state, axe });
						expect(axe, `${state}: scoped axe`).toEqual([]);
					}
				};
				try {
					await probe('[data-testid="persistent-notice"][data-notification="layout-pointer"]', 'notice');
					await page.getByTestId('notifications-bell').click();
					await probe('[data-testid="notification-item"][data-notification="layout-pointer"]', 'panel');
					await page.getByTestId('app-dialog-close').click();
					await pageRpc.call(['dev', 'emit'], { type: 'notification', payload: { show: [{ ...notice, name: 'layout-toast', is_persistent: false, duration: 60 }] } });
					await probe('[data-sonner-toast][data-styled="true"]', 'toast');
					await pageRpc.call(['dev', 'emit'], { type: 'notification', payload: { show: [{
						...notice, name: 'layout-toast', is_persistent: false, duration: 60,
						action: { schema: 1, kind: 'navigate', target: 'updates-dialog', labelKey: 'notifications.openUpdates' },
					}] } });
					await probe('[data-sonner-toast]:has([data-testid="view-logs-action"])', 'toast-two-actions');
					refuseAround = true;
					await page.locator('[data-sonner-toast]:has([data-testid="view-logs-action"])').getByTestId('view-logs-action').click();
					await probe('[data-testid="raw-anchor-failure"]', 'raw-failure');
				} finally {
					fs.mkdirSync(OUT, { recursive: true });
					fs.writeFileSync(path.join(OUT, `${locale}-${width}-${scheme}.json`), JSON.stringify({ captures, measurements }, null, 2));
				}
				expect(failures).toEqual([]);
			});
		}
	}
}
