/**
 * ShellPage — page object for the CeraUI authenticated shell.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * Wraps the global chrome: header, navigation, theme/locale toggles, HUD.
 * All specs import { test, expect } from '../fixtures/index.js'.
 * Do NOT add page.screenshot() or waitForTimeout() anywhere in this file.
 */
import { expect, type Page } from '@playwright/test';

import {
	ensureAuthenticated,
	navigateTo,
	setLocale,
	setTheme,
	type Destination,
	type ThemeMode,
} from '../helpers/index.js';
import { hudStructure } from '../helpers/aria.js';

export class ShellPage {
	constructor(private readonly page: Page) {}

	/** Navigate to / and ensure the authenticated shell is visible. */
	async gotoAuthed(): Promise<void> {
		await this.page.goto('/');
		await ensureAuthenticated(this.page);
	}

	/**
	 * Navigate to a primary destination using the existing navigateTo helper.
	 * Never hardcodes #nav-tab-* — delegates all selector logic to the helper.
	 */
	async navigate(destination: Destination): Promise<void> {
		await navigateTo(this.page, destination);
	}

	/** The app-shell header element (first <header> in the DOM). */
	get header() {
		return this.page.locator('header').first();
	}

	/**
	 * The persistent HUD root (the visible [data-hud-region] trigger button).
	 * Two instances exist (desktop top / mobile bottom dock); only one is
	 * visible at a time, so this scopes to the visible one.
	 */
	get hud() {
		return this.page.locator('[data-hud-region]').filter({ visible: true }).first();
	}

	/** Assert the authenticated shell header is visible. */
	async assertAuthedShell(): Promise<void> {
		await expect(this.header).toBeVisible();
	}

	/**
	 * Assert the HUD is structurally present (no live numeric values).
	 * Delegates to hudStructure() which uses [data-hud-region] and excludes
	 * bitrate/signal/temperature text.
	 */
	async assertHudVisible(): Promise<void> {
		await hudStructure(this.page);
	}

	/**
	 * Set the persisted theme. Writes both the app's theme store and
	 * mode-watcher's key. Reload the page for it to take effect.
	 */
	async setTheme(mode: ThemeMode): Promise<void> {
		await setTheme(this.page, mode);
	}

	/**
	 * Set the persisted locale. Reload the page for it to take effect.
	 */
	async setLocale(localeCode: string): Promise<void> {
		await setLocale(this.page, localeCode);
	}

	/** Theme toggle button (data-testid="theme-toggle"). */
	get themeToggle() {
		return this.page.getByTestId('theme-toggle');
	}

	/** Locale selector element (data-testid="locale-selector"). */
	get localeSelector() {
		return this.page.getByTestId('locale-selector');
	}
}
