/**
 * SystemLogsPage: page object for the System Logs view behind Settings.
 * Opens the view, switches tabs and runs the layout and paint audits.
 * Do NOT add page.screenshot() or waitForTimeout() in this file.
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { ensureAuthenticated, navigateTo } from '../helpers/index.js';
import { type AuditInput, type AuditResult, auditSystemLogs } from '../helpers/system-logs-audit.js';
import { auditSystemLogsPaint, type PaintResult } from '../helpers/system-logs-paint.js';

export const SYSTEM_LOGS_DIALOG = '[role="dialog"]:has([data-testid="system-logs-view"])';

export type SystemLogsTab = 'events' | 'raw' | 'storage';
export type Scheme = 'dark' | 'light';

export interface Opening {
	readonly locale: string;
	readonly size: { readonly width: number; readonly height: number };
	readonly touch: boolean;
	readonly scheme: Scheme;
}

export interface Audited extends AuditResult, Omit<PaintResult, 'found'> {
	readonly state: string;
}

export class SystemLogsPage {
	private wide = false;

	constructor(private readonly page: Page) {}

	async open({ locale, size, touch, scheme }: Opening): Promise<void> {
		this.wide = size.width >= 1024;
		await this.page.setViewportSize(size);
		await this.page.emulateMedia({ colorScheme: scheme });
		await this.page.addInitScript(
			({ code, mode }) => {
				localStorage.setItem('locale', JSON.stringify({ code }));
				localStorage.setItem('mode-watcher-mode', mode);
			},
			{ code: locale, mode: scheme },
		);
		await this.page.goto(touch ? '/?mode=touch' : '/');
		await ensureAuthenticated(this.page);
		await navigateTo(this.page, 'settings');
		await this.page.getByTestId('settings-entry-logs').click();
		await expect(this.page.getByTestId('system-logs-view').getByRole('tab').first()).toBeVisible();
		await expect(this.page.locator('html')).toHaveAttribute('lang', locale);
		await expect(this.page.locator('html')).toHaveAttribute('data-layout-mode', touch ? 'touch' : 'default');
	}

	/** Settle fonts and document animations for geometry probes. */
	async settle(): Promise<void> {
		await this.page.evaluate(async () => {
			await document.fonts.ready;
			const finite = document
				.getAnimations()
				.filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
			await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		});
	}

	async show(view: SystemLogsTab): Promise<void> {
		const tabs = this.page.getByTestId('system-logs-view').getByRole('tab');
		if (view === 'events') {
			await tabs.nth(0).click();
			await expect(this.page.getByTestId('event-row').first()).toBeVisible();
		} else if (view === 'raw') {
			await tabs.nth(1).click();
			await expect(this.page.getByTestId('raw-row').first()).toBeVisible();
		} else {
			if (!this.wide) await tabs.nth(2).click();
			await this.page.getByTestId('system-logs-storage').scrollIntoViewIfNeeded();
			await expect(this.page.getByTestId('storage-usage')).toBeVisible();
		}
		await this.settle();
	}

	/** Scroll overflowing auto or scroll descendants for the end-of-view audit. */
	async scrollToEnd(): Promise<void> {
		await this.page.locator(SYSTEM_LOGS_DIALOG).evaluate((dialog) => {
			for (const el of dialog.querySelectorAll<HTMLElement>('*')) {
				if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
					el.scrollTop = el.scrollHeight;
			}
		});
		await this.settle();
	}

	async audit(state: string, input: AuditInput): Promise<Audited> {
		const layout = await this.page.evaluate(auditSystemLogs, input);
		const paint = await this.page.evaluate(auditSystemLogsPaint, input.portals ? { portals: input.portals } : {});
		return { state, ...layout, ...paint, found: [...layout.found, ...paint.found] };
	}

	async auditViews(input: AuditInput): Promise<Audited[]> {
		const audits: Audited[] = [];
		for (const view of ['events', 'raw', 'storage'] as const) {
			await this.show(view);
			audits.push(await this.audit(view, input));
			await this.scrollToEnd();
			audits.push(await this.audit(`${view}-end`, input));
		}
		return audits;
	}

	/** Opens a select, audits its listbox with the touch checks, and closes it. */
	async auditListbox(trigger: Locator, state: string, locale: string): Promise<Audited> {
		const listbox = this.page.locator('[data-slot="select-content"]');
		await trigger.click();
		await expect(listbox).toBeVisible();
		// Require an option for the option-size audit.
		await expect(listbox.getByRole('option')).not.toHaveCount(0);
		await this.settle();
		const audit = await this.audit(state, { locale, touch: true, portals: ['[data-slot="select-content"]'] });
		await this.page.keyboard.press('Escape');
		await expect(listbox).toHaveCount(0);
		return audit;
	}
}
