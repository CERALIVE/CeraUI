/**
 * LivePage — page object for the Live destination.
 * See PLAYBOOK.md for the assertion decision tree.
 *
 * Covers: stream-control region, Encoder/Audio/Server dialogs.
 * Open/close scope only — no form submission, no stream start.
 * Do NOT add page.screenshot() or waitForTimeout().
 */
import { expect, type Page } from '@playwright/test';

import { closeDialog, openDialog } from '../helpers/aria.js';
import { ShellPage } from './shell.js';

export class LivePage {
	private readonly shell: ShellPage;

	constructor(private readonly page: Page) {
		this.shell = new ShellPage(page);
	}

	/** Navigate to the Live destination. */
	async open(): Promise<void> {
		await this.shell.navigate('live');
	}

	/** Pick the first capture/coarse/virtual source (network rows use a distinct testid). */
	async selectSource(): Promise<void> {
		const source = this.page
			.locator('[data-testid^="source-select-"]:not([disabled])')
			.first();
		await expect(source).toBeVisible({ timeout: 15_000 });
		await source.click();
		await expect(source).toHaveAttribute('data-selected', 'true', { timeout: 15_000 });
	}

	/** Open the Encoder Settings dialog. */
	async openEncoder(): Promise<void> {
		await openDialog(
			this.page,
			this.page.getByTestId('open-encoder-dialog'),
			'Encoder Settings',
		);
	}

	/** Close the Encoder Settings dialog. */
	async closeEncoder(): Promise<void> {
		await closeDialog(this.page, 'Encoder Settings');
	}

	/** Open the Audio Settings dialog. */
	async openAudio(): Promise<void> {
		await openDialog(this.page, this.page.getByTestId('open-audio-dialog'), 'Audio Settings');
	}

	/** Close the Audio Settings dialog. */
	async closeAudio(): Promise<void> {
		await closeDialog(this.page, 'Audio Settings');
	}

	/** Open the Receiver Server dialog. */
	async openServer(): Promise<void> {
		await openDialog(this.page, this.page.getByTestId('open-server-dialog'), 'Receiver Server');
	}

	/** Close the Receiver Server dialog. */
	async closeServer(): Promise<void> {
		await closeDialog(this.page, 'Receiver Server');
	}

	/**
	 * Assert a dialog is visible by role+name, and that >=1 interactive element
	 * is present inside. This is the open/close scope check per the plan.
	 */
	async assertDialogStructure(dialogName: string): Promise<void> {
		const dialog = this.page.getByRole('dialog', { name: dialogName });
		await expect(dialog).toBeVisible();
		// At least one interactive element (button, input, select, slider, etc.)
		const interactive = dialog
			.locator('button, input, select, [role="slider"], [role="combobox"]')
			.first();
		await expect(interactive).toBeVisible();
	}
}
