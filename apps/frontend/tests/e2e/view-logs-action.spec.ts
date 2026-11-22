import type { Page } from '@playwright/test';
import { type LogQueryInput, deviceStatsSchema, logAroundOutputSchema, logQueryInputSchema } from '@ceraui/rpc/schemas';

import { expect, type PageRpc, test } from './fixtures/index.js';

import { ensureAuthenticated, navigateTo, pressAndExpectRow } from './helpers/index.js';

const exports = new WeakMap<Page, { promise: Promise<unknown>; resolve(value: unknown): void }>();
const exactAnchor = new WeakSet<Page>();
const lowDisk = new WeakSet<Page>();
const queries = new WeakMap<Page, LogQueryInput[]>();
/** The newest listed event and the page's socket, so a test can push the next live event. */
const newestEvent = new WeakMap<Page, { event: Record<string, unknown>; headSeq: number }>();
const pushToPage = new WeakMap<Page, (message: string) => void>();
const listReplies = new WeakMap<Page, PromiseWithResolvers<void>>();
const replaceHistory = new WeakSet<Page>();
/** Holds a page's `logs.around` reply until the test releases it, then answers BUSY, or the device's reply when `real`. */
/** Holds a page's `logs.getStorage` reply (System Logs' availability probe) until the test releases it. */
const heldStorage = new WeakMap<Page, PromiseWithResolvers<void>>();
const heldAround = new WeakMap<Page, { release: PromiseWithResolvers<void>; sent: number; real?: boolean; ok?: unknown }>();

/** A reply frame's id and its result's `ok`, narrowed from the wire text. */
function replyOf(message: string): { id: unknown; ok: unknown } {
	const frame: unknown = JSON.parse(message);
	if (typeof frame !== 'object' || frame === null) return { id: undefined, ok: undefined };
	const result = 'result' in frame ? frame.result : undefined;
	return {
		id: 'id' in frame ? frame.id : undefined,
		ok: typeof result === 'object' && result !== null && 'ok' in result ? result.ok : undefined,
	};
}

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
		const storageIds = new Set<string>();
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
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.getStorage') storageIds.add(frame.id);
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
			const probe = heldStorage.get(page);
			if (probe && typeof message === 'string' && storageIds.has(String(replyOf(message).id))) {
				const reply = message;
				void probe.promise.then(() => {
					socket.send(reply);
					pageRpc.acceptServerMessage(reply);
				});
				return;
			}
			const held = heldAround.get(page);
			if (held && typeof message === 'string' && aroundIds.has(JSON.parse(message).id)) {
				held.ok = replyOf(message).ok;
				const reply = held.real ? message : JSON.stringify({ ...JSON.parse(message), result: { ok: false, error: 'BUSY' } });
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

test('Export keeps the scope it confirmed while the linked Raw view is still loading, and saves exactly that', async ({ page, pageRpc }) => {
	const held = { release: Promise.withResolvers<void>(), sent: 0, real: true };
	heldAround.set(page, held);
	await emit(pageRpc, {
		name: 'view-logs-late', type: 'error', msg: 'Stream failed',
		key: 'notifications.streamStartInternalFailed',
		is_dismissable: true, is_persistent: false, duration: 60,
	});
	await page.locator('[data-sonner-toast]').getByRole('button', { name: 'View logs' }).click();
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await expect.poll(() => held.sent).toBe(1);

	await logs.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Export this view' });
	const scope = confirm.getByTestId('sharing-export-scope').locator('dt, dd');
	const stated = ['Boots', 'All boots', 'Level', 'Info', 'Sources', 'All sources'];
	await expect(scope).toHaveText(stated);
	held.release.resolve();
	await expect(logs.getByTestId('raw-anchor-approximate')).toBeVisible();

	await expect(scope).toHaveText(stated);
	await confirm.getByRole('button', { name: 'Download export' }).click();
	await expect(exports.get(page)?.promise).resolves.toEqual({
		filter: { sources: [], levels: ['error', 'warning', 'info'] },
		boot: 'all',
	});
});

/** Export logs from the toolbar: the scope it states, then the request it sends. */
async function exportAll(page: Page): Promise<void> {
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await logs.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Export this view' });
	await expect(confirm.getByTestId('sharing-export-scope').locator('dt, dd')).toHaveText([
		'Boots', 'All boots', 'Level', 'Info', 'Sources', 'All sources',
	]);
	await confirm.getByRole('button', { name: 'Download export' }).click();
	await expect(exports.get(page)?.promise).resolves.toEqual({
		filter: { sources: [], levels: ['error', 'warning', 'info'] },
		boot: 'all',
	});
}

test('a phone pick of All boots while System Logs still loads outranks the linked moment, and a new Export saves it', { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
	const probe = Promise.withResolvers<void>();
	heldStorage.set(page, probe);
	await page.setViewportSize({ width: 375, height: 812 });
	await emit(pageRpc, {
		name: 'view-logs-pick', type: 'error', msg: 'Stream failed',
		key: 'notifications.streamStartInternalFailed',
		is_dismissable: true, is_persistent: false, duration: 60,
	});
	await page.locator('[data-sonner-toast]').getByRole('button', { name: 'View logs' }).click();
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await expect(logs.getByTestId('system-logs-loading')).toBeVisible();

	// All boots is already highlighted; picking it again is still the operator's action.
	await logs.getByRole('button', { name: /^Choose a boot/ }).click();
	await page.getByTestId('boot-picker').getByTestId('boot-option-all').click();
	probe.resolve();

	await expect(logs.getByTestId('raw-logs')).toBeVisible();
	await expect.poll(() => queries.get(page)?.at(-1)?.boot).toBe('all');
	await expect(logs.getByTestId('raw-anchor')).toHaveCount(0);
	await exportAll(page);
});

test('re-picking the highlighted All boots while View raw logs is out keeps its late reply from opening Raw, and a new Export saves All boots', { tag: '@desktop-only' }, async ({ page }) => {
	const held = { release: Promise.withResolvers<void>(), sent: 0, real: true };
	heldAround.set(page, held);
	await page.setViewportSize({ width: 1280, height: 800 });
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	const link = logs.getByTestId('event-row').first().getByRole('button', { name: 'View raw logs' });
	await link.click();
	await expect(link).toHaveAttribute('aria-disabled', 'true');

	await logs.getByTestId('boot-picker').getByTestId('boot-option-all').click();
	held.release.resolve();

	// Settled once the link is no longer pending; Events stays the tab and Raw never opened.
	await expect(link).not.toHaveAttribute('aria-disabled');
	await expect(logs.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true');
	await expect(logs.getByTestId('raw-logs')).toHaveCount(0);
	expect(held.sent).toBe(1);
	// The late reply was a real success, not a failure that never would have opened Raw.
	expect(held.ok).toBe(true);
	await exportAll(page);
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
