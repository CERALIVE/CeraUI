/**
 * ARIA/web-first assertion helpers for CeraUI E2E.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * RULE: No raw screenshots, no fixed-duration sleeps, no numeric millisecond
 * waits. Verify UI state via the accessibility tree — 10-50x cheaper than
 * pixel capture. Every helper below relies on web-first auto-waiting assertions.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Assert an ARIA snapshot of a locator.
 * Use wildcards (…/regex) for dynamic regions to avoid flakiness.
 * Dynamic regions (bitrate numbers, temperature, signal strength) MUST be excluded.
 */
export async function expectAria(locator: Locator, template: string): Promise<void> {
	await expect(locator).toMatchAriaSnapshot(template);
}

/**
 * Open a dialog by clicking its trigger control, then assert the dialog is visible.
 * Uses web-first assertions (auto-wait/retry — no fixed sleep needed).
 *
 * @param page - Playwright page
 * @param trigger - Locator for the button/control that opens the dialog
 * @param dialogName - Accessible name for getByRole('dialog', { name })
 */
export async function openDialog(page: Page, trigger: Locator, dialogName: string): Promise<void> {
	await trigger.click();
	await expect(page.getByRole('dialog', { name: dialogName })).toBeVisible();
}

/**
 * Close a dialog using the Escape key, then assert it is dismissed.
 * Falls back to clicking the header close button if Escape does not dismiss.
 *
 * Both AppDialog surfaces (desktop bits-ui Dialog and mobile Sheet) trap focus
 * and respond to Escape, and both expose a header close button whose accessible
 * name is "Close" ($LL.dialogs.close()). We try Escape first (cheapest), then
 * fall back to the close button — all via web-first assertions, no sleeps.
 *
 * @param page - Playwright page
 * @param dialogName - Accessible name matching the open dialog
 */
export async function closeDialog(page: Page, dialogName: string): Promise<void> {
	const dialog = page.getByRole('dialog', { name: dialogName });
	await page.keyboard.press('Escape');

	// Web-first fallback: if Escape did not dismiss within the auto-retry window,
	// click the header close button (accessible name "Close") inside the dialog.
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: 'Close' }).click();
	}

	// Auto-waits for the dialog to leave the accessibility tree / become hidden.
	await expect(dialog).toBeHidden();
}

/**
 * Assert an element is visible by role and accessible name.
 */
export async function assertVisibleByRole(
	page: Page,
	role: Parameters<Page['getByRole']>[0],
	name: string,
): Promise<void> {
	await expect(page.getByRole(role, { name })).toBeVisible();
}

/**
 * Assert a locator has the expected text content.
 */
export async function assertText(locator: Locator, text: string | RegExp): Promise<void> {
	await expect(locator).toHaveText(text);
}

/**
 * Assert an input locator has the expected value.
 */
export async function assertValue(locator: Locator, value: string | RegExp): Promise<void> {
	await expect(locator).toHaveValue(value);
}

/**
 * Return the HUD root locator and assert structural presence WITHOUT capturing
 * live values. Bitrate numbers, signal strength, temperature — all EXCLUDED
 * from any assertion here. Only structural presence is verified.
 *
 * The persistent HUD is `HudBar.svelte`, mounted via `HudRegion.svelte` in both
 * a desktop top slot and a mobile bottom dock. Its trigger button carries the
 * stable `data-hud-region` attribute (verified against the component source) —
 * the most reliable structural hook that does NOT depend on live telemetry text.
 * Two instances exist (desktop / mobile), only one visible at a time, so we
 * scope to the visible one.
 *
 * NOTE: Do NOT add `toHaveText` with numbers here — that would capture live
 * values and make the assertion flaky.
 */
export async function hudStructure(page: Page): Promise<Locator> {
	const hud = page.locator('[data-hud-region]').filter({ visible: true }).first();
	await expect(hud).toBeVisible();
	return hud;
}
