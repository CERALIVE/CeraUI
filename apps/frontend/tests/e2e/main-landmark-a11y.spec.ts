import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { isBackendSocket } from './helpers/backend-socket.js';
import { ensureAuthenticated } from './helpers/index.js';

/**
 * Every screen exposes exactly one main landmark, never nested. A mutation
 * observer installed before the app loads records the landmarks of every screen
 * the page passes through, so the transient boot and auth-check screens are
 * counted without racing them.
 */

interface LandmarkSnapshot {
	screen: string[];
	mains: number;
	nested: number;
	exposed: number;
}

declare global {
	interface Window {
		__mainLandmarks: () => LandmarkSnapshot[];
	}
}

// Sign-in fills the password and stores a session token: keep both out of retained artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const MAIN_RULES = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-main-is-top-level'];
const SIGNED_IN = [
	{ name: 'desktop', viewport: { width: 1280, height: 800 }, path: '/' },
	{ name: 'phone', viewport: { width: 390, height: 844 }, path: '/' },
	{ name: 'kiosk', viewport: { width: 1024, height: 600 }, path: '/?mode=touch' },
];

const isRpcSocket = (url: URL) => isBackendSocket(url) && url.pathname === '/ws';

/** Runs in the page before any app script; sessionStorage keeps the record across reloads. */
function recordMainLandmarks() {
	const key = 'e2e-main-landmarks';
	const seen = new Map<string, LandmarkSnapshot>(JSON.parse(sessionStorage.getItem(key) ?? '[]'));
	const shown = (element: Element | null) =>
		element !== null && element.closest('[hidden], [inert], [aria-hidden="true"]') === null;
	new MutationObserver(() => {
		if (!document.getElementById('app')?.firstElementChild) return;
		const password = document.querySelector('#password');
		const setup = shown(document.querySelector('#confirm-password'));
		const surfaces: Record<string, boolean> = {
			boot: document.querySelector('[data-boot-shell]') !== null,
			checking: document.querySelector('[data-testid="auth-check-spinner"]') !== null,
			timeout: document.querySelector('[data-testid="auth-timeout"]') !== null,
			offline: document.querySelector('[data-testid="offline-page"]') !== null,
			setup,
			'sign-in': shown(password) && !setup,
			'retained sign-in': password !== null && !shown(password),
			'signed in': document.querySelector('#main-content') !== null,
			updating: document.querySelector('[data-testid="updating-overlay"]') !== null,
		};
		const mains = [...document.querySelectorAll('main, [role="main"]')];
		const snapshot = {
			screen: Object.keys(surfaces).filter((name) => surfaces[name]),
			mains: mains.length,
			nested: mains.filter((main) => main.parentElement?.closest('main, [role="main"]')).length,
			exposed: mains.filter(shown).length,
		};
		const id = JSON.stringify(snapshot);
		if (seen.has(id)) return;
		seen.set(id, snapshot);
		sessionStorage.setItem(key, JSON.stringify([...seen]));
	}).observe(document, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ['hidden', 'inert', 'aria-hidden', 'role'],
	});
	window.__mainLandmarks = () => [...seen.values()];
}

async function expectOneMain(page: Page, screen: string) {
	await expect.soft(page.getByRole('main'), screen).toHaveCount(1);
	const { violations } = await new AxeBuilder({ page }).withRules(MAIN_RULES).analyze();
	expect.soft(violations.map(({ id }) => id), screen).toEqual([]);
}

async function expectOneMainThroughout(page: Page, screens: string[]) {
	const snapshots = await page.evaluate(() => window.__mainLandmarks());
	await test.info().attach('main-landmarks', {
		body: JSON.stringify(snapshots, null, 2),
		contentType: 'application/json',
	});
	expect(screens.filter((name) => !snapshots.some(({ screen }) => screen.includes(name))), 'never rendered').toEqual([]);
	expect(snapshots.filter(({ mains, nested, exposed }) => mains !== 1 || nested !== 0 || exposed !== 1)).toEqual([]);
}

/** The start-up reachability probe settles before the network drops, as in auth-draft-offline.spec.ts. */
async function waitForConnectivityProbe(page: Page) {
	await page.waitForFunction(() =>
		performance.getEntriesByType('resource').some(
			(entry) =>
				entry instanceof PerformanceResourceTiming &&
				new URL(entry.name).pathname === '/favicon.ico' &&
				entry.initiatorType === 'fetch' &&
				entry.responseStatus === 200,
		),
	);
}

for (const locale of ['en', 'ar']) {
	test.describe(`one main landmark per screen, ${locale}`, { tag: '@desktop-only' }, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((code) => localStorage.setItem('locale', JSON.stringify({ code })), locale);
			await page.addInitScript(recordMainLandmarks);
			// Dev-server loads overflow the default 250-entry resource buffer the probe wait reads.
			await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
		});

		test('boot, while the device has not answered @a11y', async ({ page }) => {
			// The origin probe answers in the page and the socket stays connecting, so the boot screen holds
			// over the sign-in form: a closed socket or a probe past its 500 ms budget raises the offline page.
			let answer = () => {};
			const unanswered = new Promise<void>((resolve) => {
				answer = resolve;
			});
			await page.addInitScript(() => {
				window.fetch = new Proxy(window.fetch, {
					apply: (fetch, self, args: Parameters<typeof window.fetch>) =>
						new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href).pathname ===
						'/favicon.ico'
							? Promise.resolve(new Response(null, { status: 200 }))
							: Reflect.apply(fetch, self, args),
				});
			});
			await page.routeWebSocket(isRpcSocket, () => unanswered);
			await page.goto('/');
			await expect(page.locator('[data-boot-shell]')).toBeVisible();
			await expectOneMain(page, 'boot');
			await expectOneMainThroughout(page, ['boot', 'sign-in']);
			answer();
		});

		test('sign-in and the offline page over the retained sign-in form @a11y', async ({ page, pageRpc }) => {
			// Keeps the RPC socket up while the browser is offline.
			void pageRpc;
			await page.goto('/');
			await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
			await expect(page.locator('[data-boot-shell]')).toHaveCount(0);
			await expect(page.locator('#password')).toBeVisible();
			await expectOneMain(page, 'sign-in');

			await waitForConnectivityProbe(page);
			await page.context().setOffline(true);
			await expect(page.getByTestId('offline-page')).toBeVisible();
			await expect(page.locator('#password')).toBeHidden();
			await expectOneMain(page, 'offline over the retained sign-in form');
			await expectOneMainThroughout(page, ['sign-in', 'offline', 'retained sign-in']);
		});

		test('first-run setup @a11y', async ({ page }) => {
			// The frame a device without a password sends on connect (backend rpc/adapter.ts).
			await page.routeWebSocket(isRpcSocket, (socket) => socket.send(JSON.stringify({ status: { set_password: true } })));
			await page.goto('/');
			await expect(page.locator('#confirm-password')).toBeVisible();
			await expectOneMain(page, 'setup');
			await expectOneMainThroughout(page, ['setup']);
		});

		test('the auth check and its timeout @a11y', async ({ page }) => {
			// A saved session against a device that accepts the socket and never answers.
			await page.routeWebSocket(isRpcSocket, () => {});
			await page.addInitScript(() => localStorage.setItem('auth', 'unanswered-session'));
			await page.goto('/');
			await expect(page.getByTestId('auth-timeout')).toBeVisible();
			await expectOneMain(page, 'auth timeout');
			await expectOneMainThroughout(page, ['checking', 'timeout']);
		});

		test('the signed-in shell on a desktop, a phone and a kiosk panel, and offline @a11y', async ({
			page,
			pageRpc,
		}) => {
			void pageRpc;
			for (const { name, viewport, path } of SIGNED_IN) {
				await page.setViewportSize(viewport);
				await page.goto(path);
				await ensureAuthenticated(page);
				await expectOneMain(page, name);
				// The skip link's target is that one landmark.
				await expect.soft(page.getByRole('main'), name).toHaveAttribute('id', 'main-content');
				await expect.soft(page.getByRole('main'), name).toHaveAttribute('tabindex', '-1');
			}

			await waitForConnectivityProbe(page);
			await page.context().setOffline(true);
			await expect(page.getByTestId('offline-page')).toBeVisible();
			await expectOneMain(page, 'signed-in offline');
			await expectOneMainThroughout(page, ['checking', 'signed in', 'offline']);
		});

		test('the update takeover over the signed-in shell, running and released @a11y', async ({ page, pageRpc }) => {
			await page.goto('/');
			await ensureAuthenticated(page);
			// A mid-flight install frame (no result), as updating-overlay-layers.spec.ts raises it.
			await pageRpc.call(['dev', 'emit'], {
				type: 'status',
				payload: { updating: { downloading: 2, unpacking: 0, setting_up: 0, total: 6 } },
			});
			const overlay = page.getByTestId('updating-overlay');
			await expect(overlay.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
			// A modal dialog over the shell that brings no landmark of its own: the shell keeps its one main.
			await expect(overlay).toHaveAttribute('role', 'dialog');
			await expect(overlay).toHaveAttribute('aria-modal', 'true');
			await expect(overlay.getByRole('main')).toHaveCount(0);
			await expectOneMain(page, 'update running');
			await expect.soft(page.getByRole('main'), 'update running').toHaveAttribute('id', 'main-content');

			await pageRpc.call(['dev', 'emit'], { type: 'status', payload: { updating: false } });
			await expect(overlay).toHaveCount(0);
			await expectOneMain(page, 'update released');
			await expectOneMainThroughout(page, ['signed in', 'updating']);
		});
	});
}
