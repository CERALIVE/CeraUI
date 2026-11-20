import type { Page } from '@playwright/test';
import { type LogQueryInput, deviceStatsSchema, logAroundOutputSchema, logQueryInputSchema } from '@ceraui/rpc/schemas';

import { expect, type PageRpc, test } from './fixtures/index.js';

import { ensureAuthenticated, navigateTo, pressAndExpectRow } from './helpers/index.js';

const exports = new WeakMap<Page, { promise: Promise<unknown>; resolve(value: unknown): void }>();
const exactAnchor = new WeakSet<Page>();
const lowDisk = new WeakSet<Page>();
const queries = new WeakMap<Page, LogQueryInput[]>();
/** Holds a page's `logs.around` reply until the test releases it, then answers BUSY. */
/** The newest listed event and the page's socket, so a test can push the next live event. */
const newestEvent = new WeakMap<Page, { event: Record<string, unknown>; headSeq: number }>();
const pushToPage = new WeakMap<Page, (message: string) => void>();
const listReplies = new WeakMap<Page, PromiseWithResolvers<void>>();
const replaceHistory = new WeakSet<Page>();
const heldAround = new WeakMap<Page, { release: PromiseWithResolvers<void>; sent: number }>();

/**
 * "View logs" beside a message that sends the operator to System Logs (mock
 * backend): a start failure raised through the real `notification` broadcast
 * carries the action, and pressing it opens System Logs on the Raw logs tab; a
 * notice that does not point to the logs carries none.
 */

function emit(pageRpc: PageRpc, notification: Record<string, unknown>): Promise<unknown> {
	return pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: { show: [notification] },
	});
}

test.beforeEach(async ({ page, pageRpc }) => {
	const exported = Promise.withResolvers<unknown>();
	exports.set(page, exported);
	const reads: LogQueryInput[] = [];
	queries.set(page, reads);
	// Observe the actual app RPC while retaining the fixture's real backend and lifecycle.
	await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
		const server = socket.connectToServer();
		const aroundIds = new Set<string>();
		const listIds = new Set<string>();
		pushToPage.set(page, message => {
			socket.send(message);
			pageRpc.acceptServerMessage(message);
		});
		pageRpc.bindConnectionLifecycle(socket, server);
		socket.onMessage(message => {
			server.send(message);
			if (typeof message !== 'string') return;
			const frame = JSON.parse(message);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.createExport')
				exported.resolve(frame.input);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.around')
				aroundIds.add(frame.id);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'events.list') listIds.add(frame.id);
			const counted = heldAround.get(page);
			if (counted && Array.isArray(frame.path) && frame.path.join('.') === 'logs.around') counted.sent += 1;
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.query')
				reads.push(logQueryInputSchema.parse(frame.input));
		});
		server.onMessage(message => {
			if (typeof message === 'string' && listIds.size > 0) {
				const frame = JSON.parse(message);
				const newest = listIds.has(frame.id) ? frame.result?.events?.[0] : undefined;
				if (newest) newestEvent.set(page, { event: newest, headSeq: frame.result.headSeq });
				if (listIds.has(frame.id)) listReplies.get(page)?.resolve();
				if (newest && replaceHistory.has(page)) {
					delete frame.result.epoch;
					// Reuse the seq and ID but change the second record under focus.
					frame.result.events[1].at += 1000;
					message = JSON.stringify(frame);
				}
			}
			const held = heldAround.get(page);
			if (held && typeof message === 'string' && aroundIds.has(JSON.parse(message).id)) {
				const reply = JSON.stringify({ ...JSON.parse(message), result: { ok: false, error: 'BUSY' } });
				void held.release.promise.then(() => {
					socket.send(reply);
					pageRpc.acceptServerMessage(reply);
				});
				return;
			}
			if (typeof message === 'string' && (exactAnchor.has(page) || lowDisk.has(page))) {
				const frame = JSON.parse(message);
				if (lowDisk.has(page) && frame['device-stats'] !== undefined) {
					const stats = deviceStatsSchema.parse(frame['device-stats']);
					frame['device-stats'] = { ...stats, disk: { used: 1_000_000_000, total: 1_100_000_000, type: 'SSD' } };
					message = JSON.stringify(frame);
				}
				if (aroundIds.has(frame.id)) {
					const result = logAroundOutputSchema.parse(frame.result);
					if (!result.ok) throw new Error('The mock around read failed');
					const anchor = result.older.entries[0];
					if (!anchor) throw new Error('The mock around read has no entries');
					frame.result = {
						...result, approximate: false,
						anchor: { ...anchor, message: 'matching-entry-focus-witness' },
						older: { ...result.older, entries: result.older.entries.slice(1) },
					};
					message = JSON.stringify(frame);
				}
			}
			socket.send(message);
			pageRpc.acceptServerMessage(message);
		});
	});
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
});

test('the low-disk action focuses the Storage heading', async ({ page, pageRpc }) => {
	lowDisk.add(page);
	await navigateTo(page, 'settings');
	await pageRpc.call(['dev', 'emit'], { type: 'device-stats', payload: deviceStatsSchema.parse({
		disk: { used: 1_000_000_000, total: 1_100_000_000, type: 'SSD' },
		cpuLoad1: null, socTemp: null, ifaceRxTx: null, raucSlot: 'a',
	}) });
	await page.getByTestId('low-disk-view-logs').focus();
	await page.keyboard.press('Enter');

	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	await expect(dialog.getByTestId('system-logs-storage').getByRole('heading', { name: 'Storage', exact: true })).toBeFocused();
	await expect(dialog.getByTestId('raw-logs')).toHaveCount(0);
});

test('a message opens the returned exact anchor row and gives it keyboard focus', async ({ page, pageRpc }) => {
	exactAnchor.add(page);
	await emit(pageRpc, {
		name: 'view-logs-exact', type: 'error', msg: 'Stream failed',
		key: 'notifications.streamStartInternalFailed',
		is_dismissable: true, is_persistent: false, duration: 60,
	});
	await page.locator('[data-sonner-toast]').getByRole('button', { name: 'View logs' }).click();

	const row = page.getByTestId('raw-row').filter({ hasText: 'matching-entry-focus-witness' });
	await expect(row).toHaveAttribute('data-anchor', 'true');
	await expect(row.getByRole('button')).toBeFocused();
});

test('a start failure offers View logs, which opens System Logs on Raw logs', async ({
	page,
	pageRpc,
	backendRpc,
}) => {
	const marker = 'view-logs-matching-moment;invalid-service';
	await backendRpc.call(['system', 'getLog'], { service: marker }).catch(() => undefined);
	await emit(pageRpc, {
		name: 'view-logs-start',
		type: 'error',
		msg: 'Stream failed to start',
		key: 'notifications.streamStartInternalFailed',
		is_dismissable: true,
		is_persistent: false,
		duration: 60,
	});

	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'internal error' });
	await toast.getByRole('button', { name: 'View logs' }).click();

	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await expect(logs).toBeVisible();
	await expect(logs.getByRole('tab', { name: 'Raw logs' })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await expect(logs.getByTestId('raw-anchor-approximate')).toBeVisible();
	await expect(logs.getByRole('tab', { name: 'Raw logs' })).toBeFocused();

	// On mobile, the matching entry can be below the initially mounted virtual rows.
	const matchingRow = logs.getByTestId('raw-row').filter({ hasText: marker }).first();
	const scroller = logs.getByTestId('raw-scroller');
	while ((await matchingRow.count()) === 0) {
		const advanced = await scroller.evaluate(async (el) => {
			const before = el.scrollTop;
			el.scrollTop += el.clientHeight;
			await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			return el.scrollTop > before;
		});
		if (!advanced) break;
	}
	await expect(matchingRow).toBeVisible();
});

test('Export this view saves the Raw tab current levels and text after switching to Storage', async ({
	page, backendRpc,
}) => {
	const marker = 'view-logs-filtered-export;invalid-service';
	await backendRpc.call(['system', 'getLog'], { service: marker }).catch(() => undefined);
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-logs').click();
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await logs.getByRole('tab', { name: 'Raw logs' }).click();
	await logs.getByRole('radio', { name: 'Everything', exact: true }).click();
	if (await logs.getByTestId('raw-filters-toggle').isVisible())
		await logs.getByTestId('raw-filters-toggle').click();
	await logs.getByTestId('raw-sources').click();
	await page.getByTestId('raw-source-option-app').click();
	await page.keyboard.press('Escape');
	const beforeRange = Date.now();
	await logs.getByTestId('raw-time').click();
	await page.getByTestId('raw-time-option-15m').click();
	await logs.getByTestId('raw-search').fill(marker);
	await logs.getByTestId('raw-search').press('Enter');
	await expect(logs.getByTestId('raw-row').filter({ hasText: marker }).first()).toBeVisible();
	const afterRange = Date.now();
	if (await logs.getByRole('tab', { name: 'Storage', exact: true }).count())
		await logs.getByRole('tab', { name: 'Storage', exact: true }).click();
	await logs.getByTestId('sharing-open-export').click();
	await page.getByRole('dialog', { name: 'Export this view' }).getByRole('button', { name: 'Download export' }).click();
	const shown = queries.get(page)?.at(-1);
	expect(shown?.since).toBeGreaterThanOrEqual(beforeRange - 15 * 60_000);
	expect(shown?.since).toBeLessThanOrEqual(afterRange - 15 * 60_000);
	await expect(exports.get(page)?.promise).resolves.toEqual({
		filter: { sources: ['app'], levels: ['error', 'warning', 'info', 'debug'], text: marker },
		boot: 'all', since: shown?.since,
	});
});

test('a notice that does not point to the logs offers no View logs', async ({ page, pageRpc }) => {
	await emit(pageRpc, {
		name: 'view-logs-none',
		type: 'info',
		msg: 'Flows reset',
		key: 'notifications.uplinkFlowsReset',
		params: { iface: 'eth1' },
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
	});

	const notice = page.locator(
		'[data-testid="persistent-notice"][data-notification="view-logs-none"]',
	);
	await expect(notice).toBeVisible();
	await expect(notice.getByTestId('view-logs-action')).toHaveCount(0);
});

test('a pending View raw logs keeps keyboard focus, and the arrow keys still cross its row', async ({ page }) => {
	const held = { release: Promise.withResolvers<void>(), sent: 0 };
	heldAround.set(page, held);
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	const rows = dialog.getByTestId('event-row');
	await expect(rows.nth(2)).toBeVisible();
	await rows.nth(1).evaluate((row) => row.setAttribute('data-held-row', ''));
	const pending = dialog.locator('[data-held-row]').getByRole('button', { name: 'View raw logs' });

	await pending.focus();
	await page.keyboard.press('Enter');
	await expect(pending).toBeFocused();
	await expect(pending).toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Enter');
	await pressAndExpectRow(page, 'ArrowDown');
	await pressAndExpectRow(page, 'ArrowUp');
	await expect(pending).toBeFocused();
	await pressAndExpectRow(page, 'ArrowUp');
	await pressAndExpectRow(page, 'ArrowDown');
	await expect(pending).toBeFocused();
	await pressAndExpectRow(page, 'End');
	await pressAndExpectRow(page, 'Home');
	await pressAndExpectRow(page, 'ArrowDown');
	await expect(pending).toBeFocused();

	// The held reply settles as BUSY: focus and the stop stay on the row.
	held.release.resolve();
	await expect(dialog.locator('[data-held-row]').getByTestId('event-raw-note')).toBeVisible();
	await expect(pending).toBeFocused();
	await expect(pending).not.toHaveAttribute('aria-disabled');
	await pressAndExpectRow(page, 'ArrowDown');
	expect(held.sent).toBe(1);
});

test('a live event above the focused row keeps keyboard focus and the stop on that row', async ({ page }) => {
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	const rows = dialog.getByTestId('event-row');
	await expect(rows.nth(2)).toBeVisible();
	const before = await rows.count();
	await rows.nth(1).evaluate((row) => row.setAttribute('data-held-row', ''));
	const held = dialog.locator('[data-held-row]').getByRole('button', { name: 'View raw logs' });
	await held.focus();

	const newest = newestEvent.get(page);
	if (!newest) throw new Error('The Events list reply was not observed');
	pushToPage.get(page)?.(JSON.stringify({
		event: { append: [{ ...newest.event, id: 'live-insert-witness', seq: newest.headSeq + 1 }] },
	}));
	await expect(rows).toHaveCount(before + 1);
	expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="event-row"]') !== null)).toBe(true);
	await expect(held).toBeFocused();
	await expect(held).toHaveAttribute('tabindex', '0');
	await pressAndExpectRow(page, 'ArrowUp');
	await pressAndExpectRow(page, 'ArrowDown');
	await expect(held).toBeFocused();
});

test('a sequence-gap reload that keeps the focused event keeps keyboard focus on its action', async ({ page }) => {
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	const rows = dialog.getByTestId('event-row');
	await expect(rows.nth(2)).toBeVisible();
	await rows.nth(1).evaluate((row) => row.setAttribute('data-held-row', ''));
	const held = dialog.locator('[data-held-row]').getByRole('button', { name: 'View raw logs' });
	await held.focus();

	const newest = newestEvent.get(page);
	if (!newest) throw new Error('The Events list reply was not observed');
	const relisted = Promise.withResolvers<void>();
	listReplies.set(page, relisted);
	// One seq skipped: the list reads its first page again, which still holds the focused event.
	pushToPage.get(page)?.(JSON.stringify({
		event: { append: [{ ...newest.event, id: 'gap-reload-witness', seq: newest.headSeq + 2 }] },
	}));
	await relisted.promise;
	await expect(held).toBeFocused();
	await expect(held).toHaveAttribute('tabindex', '0');
	await pressAndExpectRow(page, 'ArrowUp');
	await pressAndExpectRow(page, 'ArrowDown');
	await expect(held).toBeFocused();
});

test('a history replace with reused IDs moves focus to the list', async ({ page }) => {
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const rows = page.getByRole('dialog', { name: 'System Logs' }).getByTestId('event-row');
	await expect(rows.nth(2)).toBeVisible();
	const row = rows.nth(1);
	const recordedAt = await row.locator('time').getAttribute('datetime');
	await row.evaluate((element) => element.setAttribute('data-held-row', ''));
	await row.getByRole('button', { name: 'View raw logs' }).focus();

	const newest = newestEvent.get(page);
	if (!newest) throw new Error('The Events list reply was not observed');
	replaceHistory.add(page);
	pushToPage.get(page)?.(JSON.stringify({
		event: { append: [{ ...newest.event, id: 'history-replace-witness', seq: newest.headSeq + 2 }] },
	}));

	await expect(row.locator('time')).not.toHaveAttribute('datetime', recordedAt ?? '');
	const first = rows.first().getByRole('button', { name: 'View raw logs' });
	await expect(first).toBeFocused();
	await expect(first).toHaveAttribute('tabindex', '0');
	await expect(page.locator('[data-held-row]')).toHaveCount(0);
});
