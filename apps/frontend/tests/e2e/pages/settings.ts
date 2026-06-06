/**
 * SettingsPage — page object for the Settings destination.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * All 7 Settings trigger buttons render their entry title as visible text at
 * every breakpoint (SettingsView.svelte), so they are reachable by role+name
 * alone — no data-testid required (verified in fixtures/dialog-map.ts).
 *
 * CRITICAL: PowerDialog has destructive actions (reboot / power off), each
 * gated behind a nested "Are you sure?" confirmation. NEVER click the confirm
 * button — only assert the destructive triggers are present, then close.
 * Do NOT add page.screenshot() or waitForTimeout() anywhere in this file.
 */
import { expect, type Page } from '@playwright/test';

import { openDialog } from '../helpers/aria.js';
import { ShellPage } from './shell.js';

export class SettingsPage {
	private readonly shell: ShellPage;

	constructor(private readonly page: Page) {
		this.shell = new ShellPage(page);
	}

	/** Navigate to the Settings destination. */
	async open(): Promise<void> {
		await this.shell.navigate('settings');
	}

	// Bypass the shared closeDialog: its instant isVisible() check fires a
	// Close-button fallback mid-exit-animation, which races on detaching nodes
	// and strict-mode-violates on info dialogs that render two "Close" controls
	// (header X + footer). Escape + toBeHidden auto-retries cleanly. Same
	// convention as pages/network.ts Hotspot/ModemConfig closers.
	private async dismiss(dialogName: string): Promise<void> {
		const dialog = this.page.getByRole('dialog', { name: dialogName });
		await this.page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	// ── Cloud Remote ──────────────────────────────────────────────────────────
	async openCloudRemote(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByRole('button', { name: 'Cloud Remote Server' }),
			'Cloud Remote Server',
		);
	}
	async closeCloudRemote(): Promise<void> {
		await this.dismiss('Cloud Remote Server');
	}

	// ── Device pairing (claim code) ───────────────────────────────────────────
	/** Generate a claim code and return its trimmed text once rendered. */
	async generateClaimCode(): Promise<string> {
		await this.page.getByTestId('generate-claim-code').click();
		const code = this.page.getByTestId('claim-code');
		await expect(code).toBeVisible();
		await expect(this.page.getByTestId('claim-code-expiry')).toBeVisible();
		return ((await code.textContent()) ?? '').trim();
	}

	/** Drive the dev-only mock-platform completion and assert the paired state. */
	async simulatePairing(): Promise<void> {
		await this.page.getByTestId('simulate-pairing').click();
		await expect(this.page.getByTestId('pairing-status')).toBeVisible();
	}

	// ── Device Password ───────────────────────────────────────────────────────
	async openPassword(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByRole('button', { name: 'Device Password' }),
			'Device Password',
		);
	}
	async closePassword(): Promise<void> {
		await this.dismiss('Device Password');
	}

	// ── SSH Access ────────────────────────────────────────────────────────────
	async openSsh(): Promise<void> {
		await openDialog(this.page, this.page.getByRole('button', { name: 'SSH Access' }), 'SSH Access');
	}
	async closeSsh(): Promise<void> {
		await this.dismiss('SSH Access');
	}

	// ── System Logs ───────────────────────────────────────────────────────────
	async openLogs(): Promise<void> {
		await openDialog(this.page, this.page.getByRole('button', { name: 'System Logs' }), 'System Logs');
	}
	async closeLogs(): Promise<void> {
		await this.dismiss('System Logs');
	}

	// ── Software Updates ──────────────────────────────────────────────────────
	/**
	 * Open the Updates dialog. Opening may trigger a network/update check; we
	 * wait for the settled state via a web-first assertion (no waitForTimeout).
	 * The body resolves to either an availability count or the
	 * "No updates available" state — both render inside the visible dialog, so
	 * asserting the dialog itself is the stable settled signal.
	 */
	async openUpdates(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByRole('button', { name: 'Software Updates' }),
			'Software Updates',
		);
		// Settled state: the dialog body is mounted and visible (auto-retried).
		await expect(this.page.getByRole('dialog', { name: 'Software Updates' })).toBeVisible();
	}
	async closeUpdates(): Promise<void> {
		await this.dismiss('Software Updates');
	}

	// ── Reboot / Power (DESTRUCTIVE) ──────────────────────────────────────────
	/**
	 * Open the Power dialog and assert the destructive triggers are PRESENT.
	 *
	 * DANGER: This dialog can reboot or power off the device. The actual
	 * destructive RPC only fires from the nested "Are you sure?" confirmation
	 * dialog's primary button — which this method NEVER opens or clicks. We only
	 * verify the in-dialog "Reboot" and "Power Off" trigger buttons exist.
	 */
	async openPower(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByRole('button', { name: 'Reboot / Power' }),
			'Reboot / Power',
		);
		const dialog = this.page.getByRole('dialog', { name: 'Reboot / Power' });
		// Assert destructive triggers are present — DO NOT click them.
		await expect(dialog.getByRole('button', { name: 'Reboot' })).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Power Off' })).toBeVisible();
		// Guard: the point-of-no-return confirmation must NOT be open.
		await expect(this.page.getByRole('dialog', { name: 'Are you sure?' })).toBeHidden();
	}
	async closePower(): Promise<void> {
		await this.dismiss('Reboot / Power');
	}

	// ── Device Versions ───────────────────────────────────────────────────────
	async openVersions(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByRole('button', { name: 'Device Versions' }),
			'Device Versions',
		);
	}
	async closeVersions(): Promise<void> {
		await this.dismiss('Device Versions');
	}

	/**
	 * Assert a dialog is open and structurally sound: it is visible and exposes
	 * at least one interactive control. Every AppDialog renders a header close
	 * button (aria-label "Close"), so this holds even for info-only dialogs.
	 */
	async assertDialogStructure(dialogName: string): Promise<void> {
		const dialog = this.page.getByRole('dialog', { name: dialogName });
		await expect(dialog).toBeVisible();
		const interactive = dialog.locator('button, input, select, [role="slider"]').first();
		await expect(interactive).toBeVisible();
	}
}
