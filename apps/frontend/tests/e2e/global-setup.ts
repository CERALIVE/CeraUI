import { chromium, expect, type Page } from '@playwright/test';

/**
 * Playwright globalSetup — seeds a real persistent auth token before any worker
 * loads a spec file.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Several specs (bond-toggle-flash, field-lock, relay-notifications, …) read a
 * persistent token from `apps/backend/auth_tokens.json` at MODULE-LOAD time
 * (top-level IIFE), before any test or `beforeEach` runs. In CI the "Reset auth
 * state" step deletes that file, and `playwright.config.ts` only re-creates a
 * `{ placeholder: true }` stub — which the specs filter out, then throw:
 *   "No persistent auth tokens in auth_tokens.json; cannot authenticate e2e socket."
 *
 * A bare file-write is NOT enough: the backend's token-login path
 * (auth.procedure.ts → loginProcedure) rejects every token unless a password
 * HASH is also set, and that hash lives in memory (loaded from `config.json`'s
 * `password_hash`, which is also git-ignored and absent in CI). Only the
 * set-password flow produces it.
 *
 * globalSetup runs after `webServer` has started the backend and before workers
 * import spec files, so it drives the live app through the real auth flow:
 *   Phase 1 — set the device password (first-run). This sets the in-memory hash
 *             AND persists `password_hash` to config.json via saveConfig().
 *   Phase 2 — log in with remember-me, which sends `persistent_token: true`.
 *             The backend's genAuthToken(true) writes a real token to
 *             auth_tokens.json AND adds it to its in-memory persistentTokens —
 *             so the file and the running backend stay in sync.
 *
 * The set-password form never renders the remember-me checkbox, so it never
 * requests a persistent token on its own — hence the two distinct phases.
 */

const PORT = Number(process.env.E2E_PORT ?? 6173);
const BASE_URL = `http://localhost:${PORT}`;
const PASSWORD = process.env.E2E_PASSWORD ?? '12345678';
const NAV_TIMEOUT = 60_000;

async function reachAuthGate(page: Page): Promise<void> {
	await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
	// On a cold vite dev server (globalSetup is the first load) the app can take
	// longer than 5s to mount; index.html then reveals a full-screen #js-failed
	// debug overlay that never hides and intercepts every click. Wait for the
	// real mount signal, then drop that debug artifact before interacting.
	await page.waitForFunction(() => window.__ceraAppMounted === true, undefined, {
		timeout: NAV_TIMEOUT,
	});
	await page.evaluate(() => document.getElementById('js-failed')?.remove());
	await page.locator('#password').waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
}

/**
 * Fill the auth form and submit once it is accepted. The submit button is gated
 * by a reactive `isFormValid` derivation that lags status-driven re-renders, and
 * those re-renders can clear freshly-filled inputs. Re-fill on every poll so the
 * fields and the enabled state converge instead of racing.
 */
async function submitAuthForm(page: Page, withConfirm: boolean): Promise<void> {
	const submit = page.locator('form button[type="submit"]');
	await expect(async () => {
		await page.locator('#password').fill(PASSWORD);
		if (withConfirm) {
			await page.locator('#confirm-password').fill(PASSWORD);
		}
		await expect(submit).toBeEnabled({ timeout: 1_000 });
	}).toPass({ timeout: NAV_TIMEOUT });
	await submit.click();
	await page.locator('header').first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
}

export default async function globalSetup(): Promise<void> {
	const browser = await chromium.launch();
	try {
		// Phase 1: first-run set-password (renders a confirm field) seeds the hash.
		const setupContext = await browser.newContext();
		const setupPage = await setupContext.newPage();
		await reachAuthGate(setupPage);
		if (await setupPage.locator('#confirm-password').isVisible().catch(() => false)) {
			await submitAuthForm(setupPage, true);
		}
		await setupContext.close();

		// Phase 2: returning login with remember-me → persistent token written.
		const loginContext = await browser.newContext();
		const loginPage = await loginContext.newPage();
		await reachAuthGate(loginPage);
		const remember = loginPage.locator('#remember');
		if (await remember.isVisible().catch(() => false)) {
			await remember.check();
		}
		await submitAuthForm(loginPage, false);
		await loginContext.close();
	} finally {
		await browser.close();
	}
}
