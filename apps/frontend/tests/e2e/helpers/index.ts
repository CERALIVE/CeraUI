import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Shared E2E helpers + conventions for CeraUI agent QA.
 *
 * Key storage facts (verified against the running app, not assumed):
 * - Theme: the app store persists `theme` as JSON (`svelte-persistent-runes`,
 *   JSON serializer). The actual `dark` class on <html> is driven by
 *   `mode-watcher`, which persists a RAW string under `mode-watcher-mode`.
 *   We set BOTH so the persisted preference and the applied class agree.
 * - Locale: the app store persists `locale` as a JSON object; App.svelte reads
 *   `getLocale()?.code`, so a `{ code }` object is sufficient. The <html lang>
 *   attribute is set by typesafe-i18n once that code loads.
 */

/**
 * Absolute path to the repo-local test-artifact directory (gitignored).
 * helpers/ -> e2e -> tests -> frontend (3 up) == apps/frontend/test-results.
 * This is the single source of truth for the evidence dir — specs MUST import it
 * from here rather than recomputing an external path. Tests never write outside
 * the repo (the orchestration workspace above the checkout is off-limits).
 */
export const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../test-results');

/** Resolve an evidence screenshot path by file name. */
export function evidencePath(fileName: string): string {
	return path.join(EVIDENCE_DIR, fileName);
}

export type ThemeMode = 'dark' | 'light' | 'system';

/**
 * Set the persisted theme. Writes both the app's `theme` store (JSON) and
 * mode-watcher's `mode-watcher-mode` (raw) so the applied <html> class matches.
 * Reload the page afterwards for it to take effect at app init.
 */
export async function setTheme(page: Page, mode: ThemeMode): Promise<void> {
	await page.evaluate((value) => {
		localStorage.setItem('theme', JSON.stringify(value));
		// mode-watcher uses a raw (unquoted) string under its own key.
		localStorage.setItem('mode-watcher-mode', value);
	}, mode);
}

/**
 * Set the persisted locale. Writes the app's `locale` store as a JSON object
 * (App.svelte only reads `.code`). Reload afterwards to apply.
 */
export async function setLocale(page: Page, localeCode: string): Promise<void> {
	await page.evaluate((code) => {
		localStorage.setItem('locale', JSON.stringify({ code }));
	}, localeCode);
}

/** Return the computed value of a CSS property for the first matching element. */
export async function computedStyle(
	page: Page,
	selector: string,
	property: string,
): Promise<string> {
	return page.evaluate(
		({ selector: sel, property: prop }) => {
			const el = document.querySelector(sel);
			if (!el) {
				throw new Error(`computedStyle: no element matched selector "${sel}"`);
			}
			return getComputedStyle(el).getPropertyValue(prop).trim();
		},
		{ selector, property },
	);
}

export type Destination = 'live' | 'network' | 'settings';

/**
 * Navigate to a primary destination by clicking the active nav control.
 * Works in both layouts: desktop rail (`#nav-tab-*`) and mobile dock
 * (`#mobile-nav-tab-*`), clicking whichever is currently visible.
 */
export async function navigateTo(page: Page, destination: Destination): Promise<void> {
	const desktopTab = page.locator(`#nav-tab-${destination}`);
	const mobileTab = page.locator(`#mobile-nav-tab-${destination}`);

	const tab = (await desktopTab.isVisible().catch(() => false)) ? desktopTab : mobileTab;
	// Idempotent: when already on this destination the click is redundant and, on
	// the mobile bottom dock, can be intercepted by transient toast overlays.
	if ((await tab.getAttribute('aria-current').catch(() => null)) === 'page') return;
	await tab.click();
	await expect(tab).toHaveAttribute('aria-current', 'page');
}

/**
 * Ensure the app is past the auth gate and the authenticated shell (header) is
 * rendered. Handles both the first-run "set password" flow and the returning
 * "login" flow. Password is configurable via `E2E_PASSWORD` (default below) so
 * the same helper works against a fresh dev backend or a known-password one.
 *
 * Agent-QA note: this requires a complete topology. Local functional pages use
 * Vite :6173 with `__ceraSocketPort` selecting the fixture's 31xx worker backend;
 * CI pages use production preview :6173 with per-worker admission routing. The
 * reference backend on :3002 supports setup, not functional page traffic. A
 * frontend-only server has no auth backend and this will time out.
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
	const password = process.env.E2E_PASSWORD ?? '12345678';

	// Cold-start hardening (mirrors global-setup.ts + wifi-surface/ssh-power-update/
	// hotspot-toggle/dev-reboot-disconnect/reboot-countdown-recovery specs): under CI
	// worker contention the app can take >5s to mount, at which point index.html
	// reveals a full-screen #js-failed debug overlay (z-index 20000) that NEVER hides
	// again and intercepts every click — the dominant cause of the intermittent
	// "authedPage"/beforeEach 30s timeouts on the auth controls (both E2E shards fail
	// here). Wait for the real mount signal, then drop that debug artifact before
	// interacting. A genuine mount failure still surfaces: waitForFunction times out,
	// or the auth controls below never appear — this only removes a cosmetic overlay,
	// it never makes a broken app look authenticated.
	await page
		.waitForFunction(() => (window as any).__ceraAppMounted === true, undefined, {
			timeout: 60_000,
		})
		.catch(() => undefined);
	await page.evaluate(() => document.getElementById('js-failed')?.remove());

	// The app nests <header> inside <main>, so it has no implicit "banner" role;
	// locate the app-shell header by tag (it is the first <header> in the DOM,
	// ahead of any view-level headers). Its presence is the authed-shell signal.
	const header = page.locator('header').first();

	// Already authenticated?
	if (await header.isVisible().catch(() => false)) return;

	const passwordField = page.locator('#password');
	const confirmField = page.locator('#confirm-password');

	// Wait for either the auth form or the authed shell to appear.
	await Promise.race([
		passwordField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined),
		header.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined),
	]);

	if (await header.isVisible().catch(() => false)) return;

	await passwordField.fill(password);

	// First-run "set password" mode shows a confirm field.
	if (await confirmField.isVisible().catch(() => false)) {
		await confirmField.fill(password);
	} else {
		// Returning login: opt into remember-me so reloads stay authenticated.
		const remember = page.locator('#remember');
		if (await remember.isVisible().catch(() => false)) {
			await remember.click();
		}
	}

	await page.locator('form button[type="submit"]').click();
	await expect(header).toBeVisible({ timeout: 15_000 });

	// Persist the credential so subsequent reloads auto-authenticate.
	await page.evaluate((value) => localStorage.setItem('auth', value), password);
}
