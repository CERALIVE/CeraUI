/**
 * Auth functional spec — set-password → login determinism.
 * Password: 12345678 (standardized, see PLAYBOOK.md).
 * For the set-password test to reach the set-password form, auth_tokens.json
 * must be cleared first via: bun run --filter frontend test:e2e:reset
 *
 * This spec handles both modes gracefully — if already authenticated (stale
 * token from a prior run without reset), it skips directly to asserting the
 * authed shell. For deterministic set-password coverage, run the reset first.
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test';

import { expect, type Page, test } from './fixtures/index.js';
import { AuthPage } from './pages/auth.js';

test.describe('Auth gate', () => {
	test('set-password or login with 12345678 reaches authed shell', async ({ page }) => {
		await page.goto('/');
		// Same mount warm-up `ensureAuthenticated()` performs: without it a slow
		// cold start reveals the `#js-failed` overlay, which never hides again and
		// intercepts the clicks below. Assertions are unchanged.
		await settleAppMount(page);
		const auth = new AuthPage(page);
		const header = page.locator('header').first();

		// Short-circuit if already authenticated (returning visit / remember-me)
		if (await header.isVisible().catch(() => false)) {
			return;
		}

		// Wait for auth form
		await page.waitForSelector('#password', { timeout: 15_000 });

		if (await auth.isSetPasswordMode()) {
			// First-run: set new password
			await auth.setPassword('12345678');
		} else {
			// Returning: login with existing password
			await auth.login('12345678', { remember: true });
		}

		await auth.assertAuthed();
	});
});

/**
 * Remember-me durability, @functional.
 *
 * Two legs against ONE browser context that starts with no storage state, so
 * leg 1 drives a genuine first login and leg 2 continues from the session it
 * left behind (hence `mode: 'serial'`).
 *
 *   1. Login with remember checked → the authed shell → reload → still authed,
 *      no password screen, `localStorage.auth` populated. Nothing here writes
 *      that key the way `ensureAuthenticated()` does, precisely so the write
 *      under test is the app's own.
 *   2. The backend stops answering mid-session and is still not answering
 *      across a reload. A TRANSPORT failure is not a credential rejection: the
 *      saved credential must survive both, the reload must land on the
 *      `auth-timeout` band rather than the password screen, and the credential
 *      must still be there to auto-authenticate once the backend answers again.
 *
 * ── Why leg 2 starts MID-SESSION rather than with a bare reload ──────────────
 * The credential-deleting path this guards lives on the RECONNECT edge: a
 * transport error during re-auth used to be treated as a dead session. That path
 * is gated on the page having already authenticated, so a reload-only outage
 * never reaches it — a fresh page load has no re-auth to fail, and the leg would
 * assert a credential that was never at risk. Dropping the live socket first is
 * what puts the credential in front of the code that used to delete it.
 *
 * ── Why the refusal ACCEPTS the socket and then says nothing ─────────────────
 * A refusal that also closes the socket leaves the app flapping between
 * connected and reconnecting, which makes both the disconnect banner and the
 * `auth-timeout` band (gated on the same reconnect grace) blink in and out. An
 * accepted-but-silent socket holds the app in `connected`, so `disconnectedSince`
 * stays null and the band is stable the moment the auth check gives up. It is
 * also not a browser-offline event, so the full-page offline takeover — which
 * would replace the band and reload the page out from under the test — never
 * arms. No sleeps, per the PLAYBOOK.
 *
 * Topology: the page is routed to this worker's own 3100-3199 backend exactly
 * the way the `page` fixture does it (local dev: `window.__ceraSocketPort`;
 * CI preview: the HttpOnly routing cookie). Never a hardcoded backend port.
 */

const PASSWORD = process.env.E2E_PASSWORD ?? '12345678';

/** `<main>` carries an `id`, not a `data-testid` — see MainView.svelte. */
const MAIN_CONTENT = '#main-content';
const PASSWORD_FIELD = '#password';

/** The RPC socket is `<origin>/ws` with no query — see `getRpcSocketUrl()`. */
const RPC_SOCKET_URL = /\/ws$/;

/** Mirrors the routing cookie the `page` fixture installs under CI preview. */
const CI_PREVIEW_ROUTING_COOKIE = 'ceraui_e2e_backend_port';

/**
 * The app's own log line when a reconnect re-authentication fails
 * (`subscriptions.svelte.ts` `runReconnectReauth`). It is emitted SYNCHRONOUSLY
 * before the branch that decides the credential's fate, so observing it from
 * Node is a happens-before for reading `localStorage.auth` — without it the read
 * races the outage and passes on a tree that deletes the credential.
 */
const REAUTH_FAILURE_LOG = 'Reconnect re-auth failed';

type BackendMode =
	/** Proxy through to this worker's real backend. */
	| 'serving'
	/** Accept the connection and answer nothing, ever. */
	| 'refusing';

let sharedContext: BrowserContext | undefined;
let sharedPage: Page | undefined;
let backendMode: BackendMode = 'serving';
/** `auth.login` frames the page sent while the backend was refusing. */
let reauthAttempts = 0;

function readStoredCredential(page: Page): Promise<string | null> {
	return page.evaluate(() => localStorage.getItem('auth'));
}

/**
 * Wait for the real mount signal and drop the `#js-failed` debug overlay, which
 * index.html reveals after ~5s and never hides again while intercepting every
 * click. Same warm-up `ensureAuthenticated()` performs; a genuine mount failure
 * still surfaces, as the auth controls simply never appear.
 */
async function settleAppMount(page: Page): Promise<void> {
	await page
		.waitForFunction(
			// biome-ignore lint/suspicious/noExplicitAny: browser mount marker.
			() => (window as any).__ceraAppMounted === true,
			undefined,
			{ timeout: 60_000 },
		)
		.catch(() => undefined);
	await page.evaluate(() => document.getElementById('js-failed')?.remove());
}

/**
 * Route a self-created context to this worker's backend, mirroring the `page`
 * fixture (fixtures/index.ts). `browser.newContext()` bypasses that fixture, so
 * the routing has to be reapplied or the page dials the wrong backend.
 */
async function routeContextToWorkerBackend(
	context: BrowserContext,
	backend: { port: number; proxySecret: string },
): Promise<void> {
	if (process.env.CI === 'true') {
		await context.addCookies([
			{
				name: CI_PREVIEW_ROUTING_COOKIE,
				value: `${backend.port}.${backend.proxySecret}`,
				url: `http://localhost:${process.env.E2E_PORT ?? '6173'}`,
				httpOnly: true,
				secure: false,
				sameSite: 'Strict',
			},
		]);
		return;
	}
	await context.addInitScript((port: number) => {
		(window as { __ceraSocketPort?: number }).__ceraSocketPort = port;
	}, backend.port);
}

/**
 * Expose the page's live RPC socket so the test can drop it. Serialized into the
 * page via addInitScript, so it must be fully self-contained.
 */
function installSocketProbe(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__ceraRememberProbe) return;
	const Real = w.WebSocket;

	w.__ceraRememberProbe = {
		socket: null as WebSocket | null,
		drop(): void {
			w.__ceraRememberProbe.socket?.close();
		},
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			if (String(url).endsWith('/ws')) {
				w.__ceraRememberProbe.socket = this;
			}
		}
	}

	w.WebSocket = HookedWS;
}

/** Re-reads `backendMode` per socket, so the mode can change mid-test. */
function handleSocket(ws: WebSocketRoute): void {
	if (backendMode === 'serving') {
		ws.connectToServer();
		return;
	}
	ws.onMessage((message) => {
		if (typeof message !== 'string') return;
		try {
			const frame = JSON.parse(message) as { path?: unknown };
			if (Array.isArray(frame.path) && frame.path.join('.') === 'auth.login') {
				reauthAttempts += 1;
			}
		} catch {
			/* not an RPC frame (e.g. keepalive) */
		}
	});
}

test.describe('Remember-me', { tag: '@functional' }, () => {
	test.describe.configure({ mode: 'serial' });

	test.afterAll(async () => {
		await sharedContext?.close();
		sharedContext = undefined;
		sharedPage = undefined;
		backendMode = 'serving';
		reauthAttempts = 0;
	});

	test('a remembered login survives a reload', async ({
		browser,
		workerBackend,
		baseURL,
		viewport,
		userAgent,
	}) => {
		test.setTimeout(120_000);

		sharedContext = await browser.newContext({ baseURL, viewport, userAgent });
		await routeContextToWorkerBackend(sharedContext, workerBackend);
		await sharedContext.addInitScript(installSocketProbe);
		const page = await sharedContext.newPage();
		sharedPage = page;

		// Registered BEFORE the first navigation: Playwright installs its WebSocket
		// interception per document, so a route added afterwards never sees the
		// sockets of the document already on screen — measured, the post-navigation
		// form let a reconnect dial the real backend untouched. `backendMode` is
		// what changes behaviour later; here the route is a transparent proxy.
		backendMode = 'serving';
		reauthAttempts = 0;
		await page.routeWebSocket(RPC_SOCKET_URL, handleSocket);

		await page.goto('/');
		await settleAppMount(page);

		// A genuinely fresh context: nothing is remembered yet, so the gate is real.
		expect(await readStoredCredential(page)).toBeNull();

		const auth = new AuthPage(page);
		await page.waitForSelector(PASSWORD_FIELD, { timeout: 30_000 });
		// The worker backend is seeded with a password hash, so this is the login
		// branch — the only one that offers remember-me.
		await expect(auth.rememberCheckbox).toBeVisible();
		await auth.login(PASSWORD, { remember: true });

		await expect(page.locator(MAIN_CONTENT)).toBeVisible();
		expect(
			await readStoredCredential(page),
			'authenticate() must persist the credential itself on a remembered login',
		).not.toBeNull();

		await page.reload();
		await settleAppMount(page);

		await expect(page.locator(MAIN_CONTENT)).toBeVisible({ timeout: 60_000 });
		await expect(page.locator(PASSWORD_FIELD)).toHaveCount(0);
		expect(await readStoredCredential(page)).not.toBeNull();
	});

	test('a backend outage never deletes the remembered credential', async () => {
		test.setTimeout(180_000);

		const page = sharedPage;
		if (page === undefined) {
			throw new Error('leg 1 must have created the shared page');
		}

		// (a) The backend stops answering while the session is live.
		const reauthFailed = page.waitForEvent('console', {
			predicate: (msg) =>
				msg.type() === 'error' && msg.text().includes(REAUTH_FAILURE_LOG),
			timeout: 120_000,
		});
		backendMode = 'refusing';
		reauthAttempts = 0;
		await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
			(window as any).__ceraRememberProbe?.drop();
		});

		await reauthFailed;
		expect(
			reauthAttempts,
			'the app should have re-authenticated against the refusing backend',
		).toBeGreaterThan(0);
		expect(
			await readStoredCredential(page),
			'a transport failure is not a credential rejection',
		).not.toBeNull();
		await expect(page.locator(PASSWORD_FIELD)).toHaveCount(0);

		// (b) Reload while the backend is still refusing.
		await page.reload();
		await settleAppMount(page);

		await expect(page.getByTestId('auth-timeout')).toBeVisible({
			timeout: 60_000,
		});
		expect(
			await readStoredCredential(page),
			'a stalled auth check must not discard the credential',
		).not.toBeNull();
		await expect(page.locator(PASSWORD_FIELD)).toHaveCount(0);

		// (c) The backend answers again — the retained credential is what makes
		//     this a silent recovery rather than a re-login.
		backendMode = 'serving';
		await page.reload();
		await settleAppMount(page);

		await expect(page.locator(MAIN_CONTENT)).toBeVisible({ timeout: 60_000 });
		await expect(page.locator(PASSWORD_FIELD)).toHaveCount(0);
		expect(await readStoredCredential(page)).not.toBeNull();
	});
});
