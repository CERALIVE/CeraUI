/**
 * AuthPage — page object for the CeraUI auth gate.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * Wraps the set-password (first-run) and login (returning) flows.
 * Password: process.env.E2E_PASSWORD ?? '12345678' (standardized in helpers).
 * Do NOT add page.screenshot() or waitForTimeout() anywhere.
 *
 * Logout: there is no UI logout control in the app shell — logout exists only as
 * the `rpc.auth.logout` RPC (see src/lib/rpc/client.ts:381) with no bound button.
 * Tests that need a fresh set-password gate use the `test:e2e:reset` script
 * (removes apps/backend/auth_tokens.json), not an in-app logout. No logout method
 * is provided here because none exists in the UI.
 *
 * Selectors verified against src/main/Auth.svelte:
 *   #password               — password Input (login + set-password)
 *   #confirm-password       — confirm Input (rendered only when setPassword=true)
 *   #remember               — remember-me Checkbox (rendered only when !setPassword)
 *   form button[type=submit]— submit Button
 *   header (first)          — authed app-shell signal
 */
import { expect, type Page } from '@playwright/test';

export class AuthPage {
	constructor(private readonly page: Page) {}

	/** Password input field (first-run and login). */
	get passwordField() {
		return this.page.locator('#password');
	}

	/** Confirm password field (first-run set-password only). */
	get confirmField() {
		return this.page.locator('#confirm-password');
	}

	/** Remember-me checkbox (login flow). */
	get rememberCheckbox() {
		return this.page.locator('#remember');
	}

	/** Form submit button. */
	get submitButton() {
		return this.page.locator('form button[type="submit"]');
	}

	/**
	 * Returns true if the confirm field is visible, indicating first-run
	 * set-password mode (vs returning login mode).
	 */
	async isSetPasswordMode(): Promise<boolean> {
		return this.confirmField.isVisible().catch(() => false);
	}

	/**
	 * First-run set-password flow: fill password + confirm, then submit.
	 */
	async setPassword(pw: string): Promise<void> {
		await this.passwordField.fill(pw);
		await this.confirmField.fill(pw);
		await this.submitButton.click();
		await expect(this.page.locator('header').first()).toBeVisible({ timeout: 15_000 });
	}

	/**
	 * Returning login flow: fill password, optionally enable remember-me, submit.
	 */
	async login(pw: string, opts: { remember?: boolean } = {}): Promise<void> {
		await this.passwordField.fill(pw);
		if (opts.remember) {
			const remember = this.rememberCheckbox;
			if (await remember.isVisible().catch(() => false)) {
				await remember.click();
			}
		}
		await this.submitButton.click();
		await expect(this.page.locator('header').first()).toBeVisible({ timeout: 15_000 });
	}

	/** Click the submit button (for use after manually filling fields). */
	async submit(): Promise<void> {
		await this.submitButton.click();
	}

	/** Assert the authenticated shell (header) is visible. */
	async assertAuthed(): Promise<void> {
		await expect(this.page.locator('header').first()).toBeVisible();
	}
}
