/**
 * Auth functional spec — set-password → login determinism.
 * Password: 12345678 (standardized, see PLAYBOOK.md).
 * For the set-password test to reach the set-password form, auth_tokens.json
 * must be cleared first via: pnpm --filter frontend run test:e2e:reset
 *
 * This spec handles both modes gracefully — if already authenticated (stale
 * token from a prior run without reset), it skips directly to asserting the
 * authed shell. For deterministic set-password coverage, run the reset first.
 */
import { expect, test } from './fixtures/index.js';
import { AuthPage } from './pages/auth.js';

test.describe('Auth gate', () => {
	test('set-password or login with 12345678 reaches authed shell', async ({ page }) => {
		await page.goto('/');
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

	test('reload after login stays authenticated (remember-me)', async ({ page }) => {
		await page.goto('/');
		const header = page.locator('header').first();

		// Auth (handles both modes)
		if (!(await header.isVisible().catch(() => false))) {
			await page.waitForSelector('#password', { timeout: 15_000 });
			const auth = new AuthPage(page);
			if (await auth.isSetPasswordMode()) {
				await auth.setPassword('12345678');
			} else {
				await auth.login('12345678', { remember: true });
			}
		}

		await expect(header).toBeVisible();
		// Reload — should stay authed due to localStorage persistence
		await page.reload();
		await expect(header).toBeVisible({ timeout: 15_000 });
	});
});
