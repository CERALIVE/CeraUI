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
const heldAround = new WeakMap<Page, { release: PromiseWithResolvers<void>; sent: number; real?: boolean; ok?: unknown }>();
/** Replies held by procedure path until the test releases them (System Logs' probe, an export ticket). */
const heldReplies = new WeakMap<Page, Map<string, Promise<void>>>();

/** Holds the page's replies to `path` until the returned release runs. */
function holdReply(page: Page, path: string): () => void {
	const release = Promise.withResolvers<void>();
	const held = heldReplies.get(page) ?? new Map<string, Promise<void>>();
	held.set(path, release.promise);
	heldReplies.set(page, held);
	return () => release.resolve();
}

/** A wire frame's id, procedure path and result `ok`, decoded once and narrowed from `unknown`. */
function wire(message: string): { id: string | undefined; path: string | undefined; ok: unknown } {
	const frame: unknown = JSON.parse(message);
	if (typeof frame !== 'object' || frame === null) return { id: undefined, path: undefined, ok: undefined };
	const result = 'result' in frame ? frame.result : undefined;
	return {
		id: 'id' in frame && frame.id !== undefined ? String(frame.id) : undefined,
		path: 'path' in frame && Array.isArray(frame.path) ? frame.path.join('.') : undefined,
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
		const pathsById = new Map<string, string>();
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
			const sent = wire(message);
			if (sent.id !== undefined && sent.path !== undefined) pathsById.set(sent.id, sent.path);
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
			if (typeof message === 'string') {
				const reply = wire(message);
				const until = reply.id === undefined ? undefined : heldReplies.get(page)?.get(pathsById.get(reply.id) ?? '');
				if (until) {
					const text = message;
					void until.then(() => {
						socket.send(text);
						pageRpc.acceptServerMessage(text);
					});
					return;
				}
			}
			const held = heldAround.get(page);
			if (held && typeof message === 'string' && aroundIds.has(JSON.parse(message).id)) {
				held.ok = wire(message).ok;
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
	const releaseProbe = holdReply(page, 'logs.getStorage');
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
	releaseProbe();

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

/**
 * Keeps the closing System Logs dialog (AppDialog's fullscreen content) on the page, as its exit
 * animation would: Bits UI removes closing content only once `getAnimations()` on it have finished,
 * so these never finish. Other dialogs close as usual.
 */
async function holdClosingDialogs(page: Page): Promise<void> {
	await page.evaluate(() => {
		const never = new Promise<void>(() => {});
		const getAnimations = Element.prototype.getAnimations;
		Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
			if (this.hasAttribute('data-app-dialog-fullscreen') && this.getAttribute('data-state') === 'closed')
				return [{ finished: never, pending: false, playState: 'running' } as unknown as Animation];
			return getAnimations.call(this, options);
		};
	});
}

/** Counts the export downloads the page starts, without fetching them. */
async function countExportDownloads(page: Page): Promise<() => Promise<number>> {
	await page.evaluate(() => {
		const counter = window as unknown as { exportDownloads: number };
		const click = HTMLAnchorElement.prototype.click;
		counter.exportDownloads = 0;
		HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
			if (this.href.includes('/api/logs/export')) counter.exportDownloads += 1;
			else click.call(this);
		};
	});
	return () => page.evaluate(() => (window as unknown as { exportDownloads: number }).exportDownloads);
}

/** Every reply already sent on the page's socket has reached the page once this notice shows. */
async function barrier(page: Page, pageRpc: PageRpc, name: string): Promise<void> {
	await emit(pageRpc, {
		name, type: 'info', msg: 'Flows reset', key: 'notifications.uplinkFlowsReset',
		params: { iface: 'eth9' }, is_dismissable: true, is_persistent: true, duration: 0,
	});
	await expect(page.locator(`[data-testid="persistent-notice"][data-notification="${name}"]`)).toHaveCount(1);
}

/** The scope a newly opened Export confirmation states, then cancelled. */
async function statedScope(page: Page): Promise<string[]> {
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await logs.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Export this view' });
	const rows = await confirm.getByTestId('sharing-export-scope').locator('dt, dd').allTextContents();
	await confirm.getByRole('button', { name: 'Cancel' }).click();
	await expect(confirm).toHaveCount(0);
	return rows.map((row) => row.trim());
}

const DEFAULT_SCOPE = ['Boots', 'All boots', 'Level', 'Info', 'Sources', 'All sources'];

test('closing System Logs retires its view at once: a ticket answered during the exit starts no download, and a quick reopen exports the new view', { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const downloads = await countExportDownloads(page);
	const releaseTicket = holdReply(page, 'logs.createExport');
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-logs').click();
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	await logs.getByRole('tab', { name: 'Raw logs' }).click();
	const marker = 'retired-view-marker';
	await logs.getByTestId('raw-search').fill(marker);
	await logs.getByTestId('raw-search').press('Enter');
	await expect.poll(() => queries.get(page)?.at(-1)?.text).toBe(marker);
	await logs.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Export this view' });
	await expect(confirm.getByTestId('sharing-export-scope')).toContainText(marker);
	await confirm.getByRole('button', { name: 'Download export' }).click();
	await exports.get(page)?.promise;

	// The Settings binding closes the parent while the ticket is out; the shell stays, animating out.
	await holdClosingDialogs(page);
	await logs.getByTestId('app-dialog-close').dispatchEvent('click');
	await expect(logs).toHaveAttribute('data-state', 'closed');
	releaseTicket();
	await barrier(page, pageRpc, 'late-ticket-barrier');
	expect(await downloads()).toBe(0);

	// A quick reopen from Settings (Events, not Raw) while the closing shell is still on the page.
	await page.getByTestId('settings-entry-logs').dispatchEvent('click');
	await expect(logs).toHaveAttribute('data-state', 'open');
	await expect(logs.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true');
	expect(await statedScope(page)).toEqual(DEFAULT_SCOPE);
	expect(await downloads()).toBe(0);
});

test('a probe answered after System Logs closed opens nothing, and a quick reopen on Events exports the new view', { tag: '@desktop-only' }, async ({ page, pageRpc }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await navigateTo(page, 'settings');
	const logs = page.getByRole('dialog', { name: 'System Logs' });
	// Warm the Raw tab's chunk, so a view that outlived its close would mount Raw the moment its probe lands.
	await page.getByTestId('settings-entry-logs').click();
	await logs.getByRole('tab', { name: 'Raw logs' }).click();
	await expect(logs.getByTestId('raw-logs')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(logs).toHaveCount(0);
	const releaseProbe = holdReply(page, 'logs.getStorage');
	await emit(pageRpc, {
		name: 'view-logs-late-probe', type: 'error', msg: 'Stream failed',
		key: 'notifications.streamStartInternalFailed',
		is_dismissable: true, is_persistent: false, duration: 60,
	});
	await page.locator('[data-sonner-toast]').getByRole('button', { name: 'View logs' }).click();
	await expect(logs.getByTestId('system-logs-loading')).toBeVisible();

	await holdClosingDialogs(page);
	await logs.getByTestId('app-dialog-close').dispatchEvent('click');
	await expect(logs).toHaveAttribute('data-state', 'closed');
	releaseProbe();
	await barrier(page, pageRpc, 'late-probe-barrier');

	await page.getByTestId('settings-entry-logs').dispatchEvent('click');
	await expect(logs).toHaveAttribute('data-state', 'open');
	await expect(logs.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true');
	expect(await statedScope(page)).toEqual(DEFAULT_SCOPE);
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
