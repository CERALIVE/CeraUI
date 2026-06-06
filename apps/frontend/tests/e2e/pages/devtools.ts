/**
 * DevToolsPage — page object for the dev-only IdentityPreview showcase.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * The signal-indicator showcase (data-testid="signal-indicator-showcase") lives
 * in IdentityPreview.svelte, which is the dev-only 'identity' destination — a
 * SEPARATE nav entry from 'devtools' (see lib/config/index.ts navElements).
 *
 * Do NOT add page.screenshot() or waitForTimeout() — use web-first assertions.
 */
import { expect, type Page } from '@playwright/test';

import { ensureAuthenticated } from '../helpers/index.js';

export class DevToolsPage {
	constructor(private readonly page: Page) {}

	/**
	 * Navigate to the IdentityPreview ('identity') destination that hosts the
	 * showcase. Authenticates if needed, then clicks the visible 'identity' nav
	 * tab. navigateTo()'s Destination type covers only the three production
	 * destinations, so the dev-only tab is clicked directly (desktop or mobile).
	 */
	async open(): Promise<this> {
		await this.page.goto('/');
		await ensureAuthenticated(this.page);
		const desktopTab = this.page.locator('#nav-tab-identity');
		const mobileTab = this.page.locator('#mobile-nav-tab-identity');
		const tab = (await desktopTab.isVisible().catch(() => false)) ? desktopTab : mobileTab;
		if ((await tab.getAttribute('aria-current').catch(() => null)) !== 'page') {
			await tab.click();
			await expect(tab).toHaveAttribute('aria-current', 'page');
		}
		return this;
	}

	/**
	 * The signal-indicator showcase container (IdentityPreview.svelte, T11).
	 */
	get showcaseContainer() {
		return this.page.locator('[data-testid="signal-indicator-showcase"]');
	}

	/**
	 * Assert the showcase container is visible.
	 */
	async isShowcaseVisible(): Promise<boolean> {
		return this.showcaseContainer.isVisible().catch(() => false);
	}
}
