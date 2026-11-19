import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { expect, type Locator, type Page, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo, pressAndExpectRow } from './helpers/index.js';
import { SYSTEM_LOGS_DIALOG } from './pages/system-logs.js';

/**
 * System Logs by keyboard alone (mock backend): reach Settings from the main
 * navigation, open System Logs from its entry, cross
 * the tabs with arrow keys, change Level, follow and pause, load more, open
 * and cancel Clear all logs, and close with Escape back to the Settings entry.
 * The stops it checks must paint a focus ring.
 */

/** Presses `key` until `target` holds focus, at most `limit` times. */
async function pressTo(page: Page, target: Locator, limit: number, key = 'Tab'): Promise<void> {
	for (let presses = 0; presses < limit; presses++) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press(key);
	}
	await expect(target).toBeFocused();
}

/** Once its transitions end, the focused element paints a visible outline or a ring (a spread shadow with no offset or blur). */
async function expectFocusRing(page: Page): Promise<void> {
	const missing = await page.evaluate(async () => {
		const running = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
		await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
		const el = document.activeElement;
		if (!(el instanceof HTMLElement) || el === document.body) return 'nothing holds focus';
		const style = getComputedStyle(el);
		const outline =
			style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0 && !/, 0\)$|transparent/.test(style.outlineColor);
		const ring = /0px 0px 0px [1-9]\d*(\.\d+)?px/.test(style.boxShadow);
		return outline || ring ? '' : `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" paints no focus ring`;
	});
	expect(missing).toBe('');
}

test('System Logs works by keyboard alone and returns focus to its Settings entry', async ({ page, backendRpc }) => {
	const wide = (page.viewportSize()?.width ?? 0) >= 1024;
	// Each failing call logs entries, so Everything has a page left after one Load more.
	await Promise.all(
		Array.from({ length: 150 }, (_, index) =>
			backendRpc.call(['system', 'getLog'], { service: `keyboard-paging-${index};invalid-service` }).catch(() => undefined),
		),
	);
	await page.goto('/');
	await ensureAuthenticated(page);
	// The rail and the phone dock are both labelled Main navigation; only the one this viewport shows is visible.
	const settings = page
		.getByRole('navigation', { name: 'Main navigation' })
		.getByRole('button', { name: en['navigation.settings'], exact: true })
		.filter({ visible: true });
	await expect(settings).not.toHaveAttribute('aria-current', 'page');
	await pressTo(page, settings, 120);
	await page.keyboard.press('Enter');
	await expect(settings).toHaveAttribute('aria-current', 'page');
	const entry = page.getByTestId('settings-entry-logs');
	await pressTo(page, entry, 120);
	await page.keyboard.press('Enter');

	const dialog = page.locator(SYSTEM_LOGS_DIALOG);
	const tab = (name: string) => dialog.getByRole('tab', { name, exact: true });
	await expect(tab(en['systemLogs.tabs.events'])).toBeFocused();
	await expectFocusRing(page);

	await page.keyboard.press('ArrowRight');
	await expect(tab(en['systemLogs.tabs.raw'])).toBeFocused();
	await expect(tab(en['systemLogs.tabs.raw'])).toHaveAttribute('aria-selected', 'true');
	await expect(dialog.getByTestId('raw-row').first()).toBeVisible();

	const level = dialog.getByTestId('raw-level');
	await page.keyboard.press('Tab');
	await expect(level.getByRole('radio', { name: en['systemLogs.raw.levelInfo'] })).toBeFocused();
	await expectFocusRing(page);
	await page.keyboard.press('ArrowRight');
	const everything = level.getByRole('radio', { name: en['systemLogs.raw.levelEverything'] });
	await expect(everything).toBeFocused();
	await expect(everything).toHaveAttribute('aria-checked', 'true');
	await expect(dialog.getByTestId('raw-row').first()).toBeVisible();

	const follow = dialog.getByTestId('raw-follow-button');
	await pressTo(page, follow, 4);
	await expectFocusRing(page);
	await page.keyboard.press('Enter');
	await expect(dialog.getByTestId('raw-follow-state')).toHaveAttribute('data-state', 'following');
	await expect(follow).toHaveText(en['systemLogs.follow.pause']);
	await expect(follow).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(dialog.getByTestId('raw-follow-state')).toHaveAttribute('data-state', 'paused');
	await expect(follow).toBeFocused();

	// The virtual list renders a window of rows, so its total height shows the page arrived.
	const loadMore = dialog.getByTestId('raw-load-more-bottom');
	const list = dialog.getByTestId('raw-list');
	await pressTo(page, loadMore, 8);
	await expectFocusRing(page);
	const height = await list.getAttribute('style');
	await page.keyboard.press('Enter');
	await expect(list).not.toHaveAttribute('style', height ?? '');
	await expect(loadMore).toBeFocused();

	if (!wide) {
		await pressTo(page, tab(en['systemLogs.tabs.raw']), 20, 'Shift+Tab');
		await page.keyboard.press('ArrowRight');
		await expect(tab(en['systemLogs.tabs.storage'])).toHaveAttribute('aria-selected', 'true');
	}
	const clearAll = dialog.getByRole('button', { name: en['systemLogs.storage.clearAll'], exact: true });
	await pressTo(page, clearAll, 30);
	await expectFocusRing(page);
	await page.keyboard.press('Enter');
	const confirm = page.getByRole('alertdialog', { name: en['systemLogs.storage.clearAllTitle'] });
	await expect(confirm.getByRole('button', { name: en['dialog.cancel'], exact: true })).toBeFocused();
	await expectFocusRing(page);
	await page.keyboard.press('Enter');
	await expect(confirm).toHaveCount(0);
	await expect(clearAll).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(entry).toBeFocused();
});

test('Events rows are one tab stop that the arrow keys, Home and End move between', { tag: '@desktop-only' }, async ({ page }) => {
	await page.goto('/');
	await page.waitForFunction(
		() => '__ceraAppMounted' in window && window.__ceraAppMounted === true,
		undefined,
		{ timeout: 60_000 },
	);
	await expect(page.locator('#js-failed')).toBeHidden();
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');

	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	const rows = dialog.getByTestId('event-row');
	await expect(rows.nth(2)).toBeVisible();

	await rows.first().getByRole('button', { name: 'View raw logs' }).focus();
	await pressAndExpectRow(page, 'ArrowDown');
	await pressAndExpectRow(page, 'End');
	await pressAndExpectRow(page, 'ArrowUp');
	await pressAndExpectRow(page, 'Home');

	// A row's stop is its first action. Tab visits its other actions, then leaves the list.
	const first = dialog.locator('[data-expected-row]');
	const actions = await first.getByRole('button').count();
	for (let step = 1; step < actions; step++) {
		await page.keyboard.press('Tab');
		await expect(first.locator(':focus')).toHaveCount(1);
	}
	await page.keyboard.press('Tab');
	expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="event-row"]')))).toBe(false);
});
