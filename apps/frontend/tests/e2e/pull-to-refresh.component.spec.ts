import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };

let server: ViteDevServer | undefined;
let cacheDir: string | undefined;
let origin: string;

test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
	const frontendRoot = resolve(import.meta.dirname, '../..');
	cacheDir = await mkdtemp(join(tmpdir(), 'ceraui-refresh-component-'));
	server = await createServer({
		root: frontendRoot,
		configFile: resolve(frontendRoot, 'vite.config.ts'),
		cacheDir,
		server: { host: '127.0.0.1', port: 0, hmr: false },
		plugins: [{
			name: 'pull-refresh-component-fixture',
			configureServer(vite) {
				vite.middlewares.use((request, response, next) => {
					if (request.url !== '/__pull-refresh-component.html') {
						next();
						return;
					}
					const html = `<!doctype html><html><head></head><body>
						<div id="fixture"></div><script type="module">
						import { mount } from 'svelte';
						import { initLocale, ensureNamespaces } from '@ceraui/i18n/svelte';
						import Harness from '/src/tests/fixtures/PullToRefreshHarness.svelte';
						initLocale({ saved: 'en' });
						await ensureNamespaces(['pwa']);
						mount(Harness, { target: document.getElementById('fixture') });
						</script></body></html>`;
					void vite.transformIndexHtml(request.url, html).then((rendered) => {
						response.setHeader('Content-Type', 'text/html');
						response.end(rendered);
					}, next);
				});
			},
		}],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === 'string') throw new Error('Component HTTP listener missing');
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	try {
		await server?.close();
	} finally {
		if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
	}
});

for (const key of ['Enter', 'Space'] as const) {
	test(`pending pull refresh is reached by Tab and canceled with ${key}`, async ({ page }, testInfo) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'maxTouchPoints', { value: 1 });
		});
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto(`${origin}/__pull-refresh-component.html`);
		const before = page.getByRole('button', { name: 'Before refresh' });
		const after = page.getByRole('button', { name: 'After refresh' });
		await before.focus();
		await page.keyboard.press('Tab');
		await expect(after).toBeFocused();

		await page.evaluate(() => {
			const target = document.body;
			const start = new Touch({ identifier: 1, target, clientY: 0 });
			const end = new Touch({ identifier: 1, target, clientY: 200 });
			document.dispatchEvent(new TouchEvent('touchstart', { touches: [start] }));
			document.dispatchEvent(new TouchEvent('touchmove', { touches: [end], cancelable: true }));
			document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [end] }));
		});
		const cancel = page.getByRole('button', { name: en['pwa.refreshing'] });
		await expect(cancel).toBeVisible();
		await expect(page.getByTestId('refresh-count')).toHaveText('1');

		for (const theme of ['light', 'dark']) {
			await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
			await cancel.evaluate(async (element) => {
				void element.getBoundingClientRect();
				await Promise.all(document.getAnimations()
					.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
					.map((animation) => animation.finished));
				await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			});
			const appearance = await cancel.evaluate((element) => {
				const style = getComputedStyle(element);
				const content = element.firstElementChild;
				return {
					class: element.getAttribute('class'),
					style: element.getAttribute('style'),
					contentClass: content?.getAttribute('class'),
					box: element.getBoundingClientRect().toJSON(),
					contentBox: content?.getBoundingClientRect().toJSON(),
					display: style.display,
					font: style.font,
					color: style.color,
					background: style.backgroundColor,
					border: style.border,
					padding: style.padding,
				};
			});
			await testInfo.attach(`pointer-layout-${theme}`, {
				body: Buffer.from(JSON.stringify(appearance)),
				contentType: 'application/json',
			});
		}

		await before.focus();
		await page.keyboard.press('Tab');
		await expect(cancel).toBeFocused();
		await page.keyboard.press(key);
		await expect(cancel).toHaveCount(0);
		await before.focus();
		await page.keyboard.press('Tab');
		await expect(after).toBeFocused();
		await expect(page.getByTestId('refresh-count')).toHaveText('1');
		await page.getByRole('button', { name: 'Finish refresh' }).click();
	});
}
