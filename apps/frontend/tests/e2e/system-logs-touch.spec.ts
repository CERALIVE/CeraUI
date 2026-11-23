import type { Locator } from '@playwright/test';
import ar from '../../../../packages/i18n/messages/ar.json' with { type: 'json' };
import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { expect, test } from './fixtures/index.js';
import { SYSTEM_LOGS_DIALOG, SystemLogsPage } from './pages/system-logs.js';

async function expectTouchable(control: Locator): Promise<void> {
	await control.scrollIntoViewIfNeeded();
	const blocked = await control.evaluate((el) => {
		const { x, y, width, height } = el.getBoundingClientRect();
		const mid = { x: x + width / 2, y: y + height / 2 };
		return [[-21.5, 0], [21.5, 0], [0, -21.5], [0, 21.5]].filter(
			([dx, dy]) => !el.contains(document.elementFromPoint(mid.x + dx, mid.y + dy)),
		);
	});
	expect(blocked, `44 px hit-area edges for ${await control.ariaSnapshot()}`).toEqual([]);
}

for (const [locale, copy] of [['en', en], ['ar', ar]] as const) {
	test(`${locale}: System Logs icon and portaled controls have reachable 44 px hit areas @mobile-only`, async ({ page }) => {
		const logs = new SystemLogsPage(page);
		await logs.open({ locale, size: { width: 390, height: 844 }, touch: false, scheme: 'dark' });
		const main = page.locator(SYSTEM_LOGS_DIALOG);
		await logs.show('raw');
		await expectTouchable(main.getByTestId('app-dialog-close'));
		const search = main.getByTestId('raw-search');
		await search.fill('stream');
		const clearSearch = main.getByTestId('raw-search-clear');
		await expectTouchable(clearSearch);
		// Click outside the painted 24px icon, inside its expanded hit area.
		const iconBox = await clearSearch.boundingBox();
		if (!iconBox) throw new Error('Search Clear has no painted box');
		await page.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2 - 20);
		await expect(search).toHaveValue('');

		await main.getByTestId('boot-button').click();
		const boots = page.getByRole('dialog').filter({ has: page.getByTestId('boot-picker') });
		await logs.settle();
		await expectTouchable(boots.getByTestId('app-dialog-close'));
		await expectTouchable(boots.getByTestId('boot-option-all'));
		await expectTouchable(boots.getByTestId('boot-option').first());
		await page.keyboard.press('Escape');
		await expect(boots).toHaveCount(0);

		for (const [opener, content] of [
			['sharing-toolbar-export', 'sharing-export-scope'],
			['sharing-toolbar-bundle', 'sharing-bundle-about'],
		] as const) {
			await main.getByTestId(opener).click();
			const dialog = page.getByRole('dialog').filter({ has: page.getByTestId(content) });
			await logs.settle();
			await expectTouchable(dialog.getByTestId('app-dialog-close'));
			const footer = dialog.locator('[data-app-dialog-footer]');
			const buttons = footer.getByRole('button');
			await expect(buttons).toHaveCount(2);
			for (const button of await buttons.all()) {
				// The bundle download can still be loading; its box must not shrink.
				const size = await button.boundingBox();
				expect(size?.width).toBeGreaterThanOrEqual(44);
				expect(size?.height).toBeGreaterThanOrEqual(44);
			}
			await expectTouchable(footer.getByRole('button', { name: copy['dialogs.cancel'], exact: true }));
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
		}

		await logs.show('storage');
		for (const [trigger, action] of [
			['systemLogs.storage.clearAll', 'systemLogs.storage.clearAllConfirm'],
			['systemLogs.storage.clearEvents', 'systemLogs.storage.clearEventsConfirm'],
		] as const) {
			await main.getByRole('button', { name: copy[trigger], exact: true }).click();
			const dialog = page.getByRole('alertdialog');
			await logs.settle();
			await expectTouchable(dialog.getByRole('button', { name: copy['dialogs.cancel'], exact: true }));
			await expectTouchable(dialog.getByRole('button', { name: copy[action], exact: true }));
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
		}
	});
}
