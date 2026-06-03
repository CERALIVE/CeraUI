/**
 * NetworkPage — page object for the Network destination.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * Mock scenario: multi-modem-wifi (3 modems + WiFi). Deterministic.
 * Do NOT add waitForTimeout() — use web-first assertions for scan results.
 *
 * Four dialogs live under Network:
 *   • ModemConfig   — per-modem; trigger data-testid="open-modem-config-dialog"
 *                     (one per modem; FIRST is located dynamically). The dialog
 *                     title is the modem's reported name (DYNAMIC), so it is
 *                     asserted via getByRole('dialog') without a name filter.
 *   • Hotspot       — trigger data-testid="open-hotspot-dialog";
 *                     dialog name "Configure Hotspot".
 *   • WifiSelector  — trigger data-testid="open-wifi-selector-dialog";
 *                     dialog name "Available Networks". Waits for scan results
 *                     via a web-first assertion (NO fixed timeout).
 *   • Netif         — per-interface; trigger data-testid="open-netif-dialog"
 *                     (FIRST located dynamically); dialog name "Configure".
 */
import { expect, type Page } from '@playwright/test';

import { closeDialog, openDialog } from '../helpers/aria.js';
import { ShellPage } from './shell.js';

export class NetworkPage {
	private readonly shell: ShellPage;

	constructor(private readonly page: Page) {
		this.shell = new ShellPage(page);
	}

	/** Navigate to the Network destination. */
	async open(): Promise<void> {
		await this.shell.navigate('network');
	}

	// ── ModemConfig (per-modem, dynamic dialog title) ─────────────────────────

	/**
	 * Open the modem config dialog for the FIRST modem dynamically.
	 * Does NOT hardcode a modem ID — locates the first Configure button.
	 * The dialog title is the modem's reported name (DYNAMIC), so we assert any
	 * dialog appeared rather than matching a fixed accessible name.
	 */
	async openModemConfig(): Promise<void> {
		const trigger = this.page.getByTestId('open-modem-config-dialog').first();
		await trigger.click();
		await expect(this.page.getByRole('dialog')).toBeVisible();
	}

	async closeModemConfig(): Promise<void> {
		// Title is dynamic — close via Escape and assert the dialog is dismissed.
		await this.page.keyboard.press('Escape');
		await expect(this.page.getByRole('dialog')).toBeHidden();
	}

	// ── Hotspot ───────────────────────────────────────────────────────────────

	async openHotspot(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByTestId('open-hotspot-dialog'),
			'Configure Hotspot',
		);
	}

	async closeHotspot(): Promise<void> {
		// HotspotDialog has BOTH a header X (aria-label "Close") and a footer
		// text "Close" button, so the shared closeDialog fallback is ambiguous.
		// Close via Escape and assert dismissal with a pure web-first assertion
		// (toBeHidden auto-retries through the exit animation — no fallback race).
		const dialog = this.page.getByRole('dialog', { name: 'Configure Hotspot' });
		await this.page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	// ── WifiSelector (waits for scan results) ─────────────────────────────────

	/**
	 * Open the WiFi selector and WAIT for scan results via a web-first assertion.
	 * Never uses waitForTimeout — asserts on a network row appearing instead.
	 *
	 * Each scanned network renders a row whose SSID is a `<p title={ssid}>`
	 * (WifiSelectorDialog.svelte). That `title` attribute is unique to network
	 * rows in this dialog, so it is the most reliable structural signal that the
	 * scan has produced results. The auto-retry window covers scan latency.
	 */
	async openWifiSelector(): Promise<void> {
		const trigger = this.page.getByTestId('open-wifi-selector-dialog');
		await trigger.click();
		const dialog = this.page.getByRole('dialog', { name: 'Available Networks' });
		await expect(dialog).toBeVisible();
		// Web-first wait for scan results: a network row (SSID paragraph) appears.
		await expect(dialog.locator('p[title]').first()).toBeVisible({ timeout: 15_000 });
	}

	async closeWifiSelector(): Promise<void> {
		// Like Hotspot, this dialog exposes two "Close" controls (header X +
		// info-only footer button), so the shared closeDialog fallback is
		// ambiguous. Dismiss via Escape with a pure web-first assertion.
		const dialog = this.page.getByRole('dialog', { name: 'Available Networks' });
		await this.page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	// ── Netif (per-interface) ─────────────────────────────────────────────────

	async openNetif(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByTestId('open-netif-dialog').first(),
			'Configure',
		);
	}

	async closeNetif(): Promise<void> {
		await closeDialog(this.page, 'Configure');
	}

	// ── Structure assertion ───────────────────────────────────────────────────

	/**
	 * Assert a dialog is open and structurally interactive.
	 * Pass the literal 'modem' for the ModemConfig dialog (dynamic title) — it is
	 * matched by role alone; any other value matches by accessible name.
	 */
	async assertDialogStructure(dialogName: string | RegExp): Promise<void> {
		const dialog =
			dialogName === 'modem'
				? this.page.getByRole('dialog')
				: this.page.getByRole('dialog', { name: dialogName });
		await expect(dialog).toBeVisible();
		const interactive = dialog.locator('button, input, select, [role="slider"]').first();
		await expect(interactive).toBeVisible();
	}
}
