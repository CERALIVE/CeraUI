/**
 * PWA offline-upgrade gate for the typesafe-i18n -> Paraglide migration.
 *
 * GATE CLASSIFICATION — run-once, LOCAL ONLY, and deliberately so.
 *
 * Its input is `test-results/premigration-build/`, a gitignored archive of the
 * SPA built at the pre-migration commit (plan todo 19). A fresh clone and CI do
 * not have it and cannot reconstruct it, so this spec is tagged
 * `@premigration-upgrade` and grep-inverted out of BOTH the root `test:e2e`
 * script and the Functional E2E step in `build-check.yml`. It is NOT a weakened
 * or skipped test: it is a new spec whose declared scope is one migration, run
 * explicitly with
 *
 *   bun run --filter frontend test:e2e -- --grep @premigration-upgrade
 *
 * and archived to evidence. It will never be expected green in the default suite.
 *
 * WHAT IT PROVES. An installed pre-migration service worker holds a precache
 * manifest naming assets the post-migration build no longer emits. If the SW did
 * not take the update, a device that had CeraUI open across an OTA would serve a
 * stale shell forever. And because the app now awaits `ensureAllNamespaces()`
 * before `mount()`, `window.__ceraAppMounted` going true WHILE OFFLINE is a
 * direct, non-circumstantial proof that every lazily-imported i18n namespace
 * chunk — the split this migration introduced — was precached and served from
 * the cache. A missing chunk cannot produce a mounted app.
 *
 * It serves both builds from ONE repo-local static server whose document root is
 * swapped between phases, so the origin (and therefore the SW registration and
 * its caches) is identical across the upgrade — which is the situation on a
 * device, and the only one where "did the SW update?" is a real question.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const FRONTEND_ROOT = path.resolve(import.meta.dirname, '../..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '../..');
const PREMIGRATION = path.join(REPO_ROOT, 'test-results/premigration-build/public');
const POSTMIGRATION = path.join(REPO_ROOT, 'dist/public');

const CONTENT_TYPES = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.js', 'application/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.webmanifest', 'application/manifest+json'],
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.ico', 'image/x-icon'],
	['.woff2', 'font/woff2'],
	['.xml', 'application/xml'],
]);

/** Serves whichever build `root` currently names — swapping it IS the upgrade. */
async function startSwappableServer(initialRoot: string): Promise<{
	server: Server;
	setRoot(next: string): void;
	origin(): string;
}> {
	let root = initialRoot;
	const server = createServer((request, response) => {
		const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
		const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
		const file = path.join(root, relative);
		// Containment: a traversal outside the served build would let this fixture
		// read the rest of the checkout.
		if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
			response.writeHead(404).end('not found');
			return;
		}
		response.writeHead(200, {
			'content-type': CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream',
			// The SW update check must see the network copy, not a browser-cached one.
			'cache-control': 'no-cache',
			'service-worker-allowed': '/',
		});
		createReadStream(file).pipe(response);
	});
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
	return {
		server,
		setRoot: (next: string) => {
			root = next;
		},
		origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}

/** Every url in a build's injected `precacheAndRoute([...])` manifest. */
function precacheUrls(buildRoot: string): string[] {
	const sw = readFileSync(path.join(buildRoot, 'sw.js'), 'utf8');
	const start = sw.indexOf('[', sw.indexOf('precacheAndRoute('));
	let depth = 0;
	let end = -1;
	for (let index = start; index < sw.length; index += 1) {
		if (sw[index] === '[') depth += 1;
		else if (sw[index] === ']' && --depth === 0) {
			end = index;
			break;
		}
	}
	return [...sw.slice(start, end + 1).matchAll(/["']?url["']?\s*:\s*["']([^"']+)["']/g)].map(
		(match) => (match[1] ?? '').replace(/^\.?\//, ''),
	);
}

test.describe('@premigration-upgrade PWA offline upgrade across the i18n migration', () => {
	test.skip(
		!existsSync(PREMIGRATION) || !existsSync(POSTMIGRATION),
		`needs the archived pre-migration build at ${PREMIGRATION} and a current build at ${POSTMIGRATION}`,
	);

	test('a pre-migration service worker updates, then serves every lazy chunk offline', async ({
		browser,
	}) => {
		test.setTimeout(180_000);
		const hosting = await startSwappableServer(PREMIGRATION);
		const origin = hosting.origin();
		const context = await browser.newContext({ baseURL: origin });
		const page = await context.newPage();

		try {
			// PHASE 1 — install the pre-migration service worker.
			await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
			await page.waitForFunction(
				() => navigator.serviceWorker.controller !== null,
				undefined,
				{ timeout: 60_000 },
			);
			const beforeAssets = await page.evaluate(async () => {
				const names = await caches.keys();
				const entries = await Promise.all(
					names.map(async (name) => (await caches.open(name)).keys()),
				);
				return entries.flat().map((request) => new URL(request.url).pathname);
			});
			const premigrationOnly = precacheUrls(PREMIGRATION).filter(
				(url) => !precacheUrls(POSTMIGRATION).includes(url),
			);
			expect(
				premigrationOnly.length,
				'the two builds emit identical assets, so this spec would prove nothing',
			).toBeGreaterThan(0);
			expect(beforeAssets.some((asset) => asset.includes('/assets/'))).toBe(true);

			// PHASE 2 — the OTA: same origin, new build.
			hosting.setRoot(POSTMIGRATION);
			await page.reload({ waitUntil: 'load' });
			const postAssets = precacheUrls(POSTMIGRATION);
			await page.waitForFunction(
				async (expected: string[]) => {
					const names = await caches.keys();
					const entries = await Promise.all(
						names.map(async (name) => (await caches.open(name)).keys()),
					);
					const cached = new Set(
						entries.flat().map((request) => new URL(request.url).pathname.replace(/^\//, '')),
					);
					return expected.every((url) => cached.has(url));
				},
				postAssets,
				{ timeout: 90_000 },
			);

			// PHASE 3 — offline. The app must still boot, and booting requires every
			// i18n namespace chunk (main.ts awaits them before mount).
			await context.setOffline(true);
			await page.reload({ waitUntil: 'load' });
			await page.waitForFunction(() => window.__ceraAppMounted === true, undefined, {
				timeout: 60_000,
			});

			// The app itself is the assertion. `main.ts` awaits every lazily-imported
			// i18n namespace chunk before `mount()`, so `__ceraAppMounted` cannot go
			// true unless all of them were served from the upgraded cache with the
			// network cut. A missing chunk hangs the boot instead.
			expect(await page.evaluate(() => window.__ceraAppMounted === true)).toBe(true);

			// Falsification guard: without proof the network is genuinely cut, a boot
			// served straight off the origin would satisfy the assertion above.
			// `navigator.onLine` is not that proof — Playwright's setOffline blocks
			// requests without flipping it — so ask for something no cache can hold.
			const reachedNetwork = await page.evaluate(async () => {
				try {
					await fetch(`/never-precached-${Date.now()}.txt`, { cache: 'no-store' });
					return true;
				} catch {
					return false;
				}
			});
			expect(reachedNetwork).toBe(false);
		} finally {
			await context.close();
			await new Promise((resolve) => hosting.server.close(resolve));
		}
	});
});
