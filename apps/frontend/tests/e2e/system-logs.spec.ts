import fs from 'node:fs';

import {
	eventListOutputSchema,
	logFollowStopOutputSchema,
	type LogQueryPage,
	logQueryOutputSchema,
	logQueryPageSchema,
} from '@ceraui/rpc/schemas';

import en from '../../../../packages/i18n/messages/en.json' with { type: 'json' };
import { LOG_POINTER_KEYS } from '../../src/lib/device-logs/log-pointer-keys.js';
import type { WorkerBackend } from './fixtures/backend.js';
import { type BackendRpc, expect, type Locator, type Page, type PageRpc, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { SYSTEM_LOGS_DIALOG } from './pages/system-logs.js';

/**
 * System Logs end to end on the mock backend: Events, the jump to Raw logs,
 * Level and search, paging, Follow, Clear all, a View logs message, the
 * legacy downloads, and where keyboard focus goes when a paging button leaves.
 */

type Tab = 'events' | 'raw' | 'storage';
const TAB_NAMES: Record<Tab, string> = {
	events: en['systemLogs.tabs.events'],
	raw: en['systemLogs.tabs.raw'],
	storage: en['systemLogs.tabs.storage'],
};

interface Entry {
	readonly cursor: string;
	readonly text: string;
	readonly ts: number;
}

interface Frame {
	readonly id?: string;
	readonly path?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

const REPLY_DEADLINE_MS = 10_000;

interface Bound {
	readonly path: string;
	id?: string;
}

/**
 * The page's RPC socket, observed. Each reply wait and each rewrite binds to the next request
 * on its path and then to that request's reply alone; a wait rejects at its deadline.
 */
class Wire {
	readonly #waits: (Bound & { settle(result: unknown): void })[] = [];
	readonly #rewrites: (Bound & { rewrite(frame: Frame): Frame })[] = [];
	readonly #requests = new Map<string, number>();
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();

	static async install(page: Page, pageRpc: PageRpc): Promise<Wire> {
		const wire = new Wire();
		page.once('close', () => {
			for (const timer of wire.#timers) clearTimeout(timer);
		});
		await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
			const server = socket.connectToServer();
			pageRpc.bindConnectionLifecycle(socket, server);
			socket.onMessage((message) => {
				if (typeof message === 'string') wire.#request(message);
				server.send(message);
			});
			server.onMessage((message) => {
				const forwarded = typeof message === 'string' ? wire.#reply(message) : message;
				socket.send(forwarded);
				pageRpc.acceptServerMessage(forwarded);
			});
		});
		return wire;
	}

	/** Resolves with the result of the reply to the next `path` request; call it before the action that sends it. */
	reply(path: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#timers.delete(timer);
				this.#waits.splice(this.#waits.indexOf(wait), 1);
				reject(new Error(`no ${path} reply within ${REPLY_DEADLINE_MS} ms`));
			}, REPLY_DEADLINE_MS);
			const wait = {
				path,
				settle: (result: unknown) => {
					clearTimeout(timer);
					this.#timers.delete(timer);
					resolve(result);
				},
			};
			this.#timers.add(timer);
			this.#waits.push(wait);
		});
	}

	rewriteNext(path: string, rewrite: (frame: Frame) => Frame): void {
		this.#rewrites.push({ path, rewrite });
	}

	requests(path: string): number {
		return this.#requests.get(path) ?? 0;
	}

	#request(message: string): void {
		const frame: Frame = JSON.parse(message);
		if (frame.id === undefined || !Array.isArray(frame.path)) return;
		const path = frame.path.join('.');
		this.#requests.set(path, this.requests(path) + 1);
		for (const queue of [this.#waits, this.#rewrites]) {
			const next = queue.find((one) => one.path === path && one.id === undefined);
			if (next) next.id = frame.id;
		}
	}

	#reply(message: string): string {
		const frame: Frame = JSON.parse(message);
		if (frame.id === undefined) return message;
		const rewrite = this.#rewrites.findIndex((one) => one.id === frame.id);
		const sent = rewrite < 0 ? frame : (this.#rewrites.splice(rewrite, 1)[0]?.rewrite(frame) ?? frame);
		const wait = this.#waits.findIndex((one) => one.id === frame.id);
		if (wait >= 0) this.#waits.splice(wait, 1)[0]?.settle(sent.result);
		return rewrite < 0 ? message : JSON.stringify(sent);
	}
}

/** The backend rejects the unit name and traces the request, marker included, in its log. */
async function logMarker(backendRpc: BackendRpc, marker: string): Promise<void> {
	await backendRpc.call(['system', 'getLog'], { service: `${marker};invalid-service` }).catch(() => undefined);
}

async function openSystemLogs(page: Page): Promise<Locator> {
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-logs').click();
	const dialog = page.locator(SYSTEM_LOGS_DIALOG);
	await expect(dialog).toBeVisible();
	return dialog;
}

function tab(dialog: Locator, name: Tab): Locator {
	return dialog.getByRole('tab', { name: TAB_NAMES[name], exact: true });
}

function deviceStarted(dialog: Locator): Locator {
	return dialog.getByTestId('event-row').filter({ hasText: en['timeline.device_started.title'] });
}

function rawRows(dialog: Locator, text: string): Locator {
	return dialog.getByTestId('raw-row').filter({ hasText: text });
}

async function showRaw(dialog: Locator, wire: Wire): Promise<void> {
	const landed = wire.reply('logs.query');
	await tab(dialog, 'raw').click();
	await landed;
	await expect(dialog.getByTestId('raw-loading')).toHaveCount(0);
}

async function showStorage(dialog: Locator): Promise<void> {
	// The tabs mount once the view is ready; narrow screens show Storage as a tab.
	await expect(tab(dialog, 'events')).toBeVisible();
	if ((await tab(dialog, 'storage').count()) > 0) await tab(dialog, 'storage').click();
	await expect(dialog.getByTestId('storage-usage')).toBeVisible();
}

async function chooseEverything(dialog: Locator, wire: Wire): Promise<void> {
	const everything = dialog.getByTestId('raw-level').getByRole('radio', { name: en['systemLogs.raw.levelEverything'] });
	const landed = wire.reply('logs.query');
	await everything.click();
	await landed;
	await expect(everything).toHaveAttribute('aria-checked', 'true');
	await expect(dialog.getByTestId('raw-loading')).toHaveCount(0);
}

/** Every listed Raw logs entry by list position, read by scrolling the virtual list from end to end. */
async function listedEntries(dialog: Locator): Promise<Entry[]> {
	const entries = await dialog.getByTestId('raw-scroller').evaluate(async (scroller) => {
		const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const seen = new Map<number, { cursor: string; text: string; ts: number }>();
		const start = scroller.scrollTop;
		scroller.scrollTop = 0;
		await painted();
		for (;;) {
			for (const item of scroller.querySelectorAll<HTMLElement>('li[data-index]')) {
				const row = item.querySelector('[data-testid="raw-row"]');
				const cursor = row?.getAttribute('data-cursor');
				const ts = Date.parse(row?.querySelector('time')?.getAttribute('datetime') ?? '');
				if (cursor) seen.set(Number(item.dataset.index), { cursor, text: row?.textContent ?? '', ts });
			}
			const before = scroller.scrollTop;
			scroller.scrollTop = before + scroller.clientHeight;
			await painted();
			if (scroller.scrollTop === before) break;
		}
		scroller.scrollTop = start;
		await painted();
		return [...seen.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
	});
	return entries;
}

async function loadMore(dialog: Locator, wire: Wire, end: 'top' | 'bottom' = 'bottom'): Promise<unknown> {
	const landed = wire.reply('logs.query');
	await dialog.getByTestId(`raw-load-more-${end}`).focus();
	await dialog.page().keyboard.press('Enter');
	const result = await landed;
	await expect(dialog.getByTestId(`raw-loading-${end}`)).toHaveCount(0);
	return result;
}

/** A second app page on the same worker backend. In a local run the page fixture sets the socket port on its own page, not this one. */
async function secondPage(page: Page, workerBackend: WorkerBackend): Promise<Page> {
	const second = await page.context().newPage();
	if (process.env.CI !== 'true')
		await second.addInitScript((port: number) => {
			(window as { __ceraSocketPort?: number }).__ceraSocketPort = port;
		}, workerBackend.port);
	return second;
}

/** The next `pages` Events pages claim older events before the oldest listed one, so Load older events stays. */
function claimOlderEvents(wire: Wire, pages: number): void {
	let oldest: number | undefined;
	for (let claimed = 0; claimed < pages; claimed++)
		wire.rewriteNext('events.list', (frame) => {
			const list = eventListOutputSchema.parse(frame.result);
			oldest ??= Math.min(...list.events.map((event) => event.seq));
			return { ...frame, result: { ...list, nextBeforeSeq: oldest } };
		});
}

async function loadOlderEvents(dialog: Locator, wire: Wire): Promise<void> {
	const landed = wire.reply('events.list');
	await dialog.getByRole('button', { name: en['systemLogs.events.loadOlder'] }).focus();
	await dialog.page().keyboard.press('Enter');
	await landed;
	await expect(dialog.getByTestId('events-loading-older')).toHaveCount(0);
}

function rewritePage(wire: Wire, page: Partial<LogQueryPage>): void {
	wire.rewriteNext('logs.query', (frame) => {
		const result = logQueryOutputSchema.parse(frame.result);
		return { ...frame, result: result.ok ? { ...result, ...page } : result };
	});
}

async function startFollow(dialog: Locator): Promise<void> {
	const button = dialog.getByTestId('raw-follow-button');
	await button.click();
	await expect(dialog.getByTestId('raw-follow-state')).toHaveAttribute('data-state', 'following');
	await expect(button).not.toHaveAttribute('aria-busy', 'true');
}

test('opens on Events, which lists the device start', async ({ page }) => {
	const dialog = await openSystemLogs(page);
	await expect(deviceStarted(dialog)).toBeVisible({ timeout: 2_000 });
	await expect(tab(dialog, 'events')).toHaveAttribute('aria-selected', 'true');
});

test('View raw logs on the device start opens Raw logs at that moment', async ({ page }) => {
	const dialog = await openSystemLogs(page);
	await deviceStarted(dialog).getByRole('button', { name: en['systemLogs.events.viewRaw'] }).click();

	await expect(tab(dialog, 'raw')).toHaveAttribute('aria-selected', 'true');
	const anchor = dialog.locator('[data-testid="raw-row"][data-anchor="true"]');
	await expect(anchor.or(dialog.getByTestId('raw-anchor-approximate')).first()).toBeVisible();
});

test('Everything keeps or adds Raw rows, and a search leaves only matching rows', async ({ page, pageRpc, backendRpc }) => {
	const marker = `system-logs-search-${test.info().project.name}`;
	const wire = await Wire.install(page, pageRpc);
	const dialog = await openSystemLogs(page);
	await showRaw(dialog, wire);
	const info = await listedEntries(dialog);
	await chooseEverything(dialog, wire);
	expect((await listedEntries(dialog)).length).toBeGreaterThanOrEqual(info.length);

	await logMarker(backendRpc, marker);
	const search = dialog.getByTestId('raw-search');
	const landed = wire.reply('logs.query');
	await search.fill(marker);
	await search.press('Enter');
	await landed;
	await expect(rawRows(dialog, marker).first()).toBeVisible();
	const found = await listedEntries(dialog);
	expect(found.length).toBeGreaterThan(0);
	expect(found.filter((entry) => !entry.text.includes(marker))).toEqual([]);
});

test('Load more adds older rows and lists each entry once', async ({ page, pageRpc, backendRpc }) => {
	await Promise.all(Array.from({ length: 120 }, (_, index) => logMarker(backendRpc, `system-logs-paging-${index}`)));
	const wire = await Wire.install(page, pageRpc);
	const dialog = await openSystemLogs(page);
	await showRaw(dialog, wire);
	await chooseEverything(dialog, wire);
	const before = await listedEntries(dialog);

	const reply = logQueryPageSchema.parse(await loadMore(dialog, wire));
	const listed = new Set(before.map((entry) => entry.cursor));
	expect(reply.entries.filter((entry) => listed.has(entry.cursor))).toEqual([]);
	const after = await listedEntries(dialog);
	const cursors = after.map((entry) => entry.cursor);
	expect(new Set(cursors).size).toBe(cursors.length);
	expect(cursors.slice(0, before.length)).toEqual(before.map((entry) => entry.cursor));
	const added = after.slice(before.length);
	expect(added.length).toBeGreaterThan(0);
	const oldestBefore = Math.min(...before.map((entry) => entry.ts));
	expect(added.filter((entry) => !(entry.ts <= oldestBefore))).toEqual([]);
});

test('Follow shows a new line live, Pause holds the next one back, and Resume shows it once', async ({
	page,
	pageRpc,
	backendRpc,
	workerBackend,
}) => {
	const live = `system-logs-live-${test.info().project.name}`;
	const held = `system-logs-held-${test.info().project.name}`;
	const order = `system-logs-order-${test.info().project.name}`;
	const wire = await Wire.install(page, pageRpc);
	const dialog = await openSystemLogs(page);
	await showRaw(dialog, wire);
	await chooseEverything(dialog, wire);
	await startFollow(dialog);
	// A second view keeps following, so the held line's arrival there shows the device has sent it.
	const witnessPage = await secondPage(page, workerBackend);
	const witness = await openSystemLogs(witnessPage);
	await tab(witness, 'raw').click();
	await witness.getByTestId('raw-level').getByRole('radio', { name: en['systemLogs.raw.levelEverything'] }).click();
	await expect(witness.getByTestId('raw-row').first()).toBeVisible();
	await startFollow(witness);

	const reads = wire.requests('logs.query');
	await logMarker(backendRpc, live);
	await expect(rawRows(dialog, live)).toHaveCount(1);
	expect(wire.requests('logs.query')).toBe(reads);

	const follow = dialog.getByTestId('raw-follow-button');
	const stopped = wire.reply('logs.followStop');
	await follow.click();
	// The device sends this reply after it has stopped this page's follower.
	expect(logFollowStopOutputSchema.parse(await stopped).success).toBe(true);
	await expect(dialog.getByTestId('raw-follow-state')).toHaveAttribute('data-state', 'paused');
	await expect(follow).not.toHaveAttribute('aria-busy', 'true');
	await logMarker(backendRpc, held);
	await expect(rawRows(witness, held)).toHaveCount(1);
	// This notice orders frames already sent on the original page's socket.
	await pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: {
			show: [
				{ name: order, type: 'info', msg: order, is_dismissable: true, is_persistent: false, duration: 60 },
			],
		},
	});
	await expect(page.locator('[data-sonner-toast]').filter({ hasText: order })).toBeVisible();
	await expect(rawRows(dialog, held)).toHaveCount(0);

	await follow.click();
	await expect(dialog.getByTestId('raw-follow-state')).toHaveAttribute('data-state', 'following');
	await expect(rawRows(dialog, held)).toHaveCount(1);
	await witnessPage.close();
});

test('Clear all logs removes the listed entries, logs the clear and keeps the events', async ({ page, pageRpc }) => {
	const wire = await Wire.install(page, pageRpc);
	const dialog = await openSystemLogs(page);
	await expect(deviceStarted(dialog)).toBeVisible();
	await showStorage(dialog);
	await expect(dialog.getByTestId('storage-usage-text')).toHaveAttribute('data-state', 'reported');
	await showRaw(dialog, wire);
	const listed = new Set((await listedEntries(dialog)).map((entry) => entry.cursor));
	expect(listed.size).toBeGreaterThan(0);

	await showStorage(dialog);
	await dialog.getByRole('button', { name: en['systemLogs.storage.clearAll'], exact: true }).click();
	const confirm = page.getByRole('alertdialog', { name: en['systemLogs.storage.clearAllTitle'] });
	const cleared = wire.reply('logs.clearAll');
	await confirm.getByRole('button', { name: en['systemLogs.storage.clearAllConfirm'], exact: true }).click();
	await cleared;
	await tab(dialog, 'raw').click();
	await expect(rawRows(dialog, 'device logs cleared')).toBeVisible();
	const remaining = (await listedEntries(dialog)).filter((entry) => listed.has(entry.cursor));
	expect(remaining).toEqual([]);

	await tab(dialog, 'events').click();
	await expect(deviceStarted(dialog)).toBeVisible();
});

test('a log-pointing message offers View logs, which opens Raw logs', async ({ page, pageRpc }) => {
	const key = 'notifications.streamRecoveryFailed';
	expect(LOG_POINTER_KEYS.has(key)).toBe(true);
	await page.goto('/');
	await ensureAuthenticated(page);
	await pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: {
			show: [
				{ name: 'system-logs-pointer', type: 'error', msg: en[key], key, is_dismissable: true, is_persistent: false, duration: 60 },
			],
		},
	});
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: en[key] });
	await toast.getByRole('button', { name: en['notifications.viewLogs'] }).click();

	const dialog = page.locator(SYSTEM_LOGS_DIALOG);
	await expect(tab(dialog, 'raw')).toHaveAttribute('aria-selected', 'true');
	await expect(dialog.getByTestId('raw-row').first()).toBeVisible();
});

test('the legacy device log row still downloads the service log', async ({ page }) => {
	const dialog = await openSystemLogs(page);
	await showStorage(dialog);
	const downloading = page.waitForEvent('download');
	await dialog.getByTestId('log-download-device').click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('ceralive.service_log.txt');
	expect(fs.readFileSync(await download.path(), 'utf8')).toContain('CeraUI mock journal');
});

test.describe('a paging button that its page replaces hands keyboard focus on', () => {
	test('to Keep searching after a page that stops on the search budget', async ({ page, pageRpc, backendRpc }) => {
		await Promise.all(Array.from({ length: 120 }, (_, index) => logMarker(backendRpc, `system-logs-budget-${index}`)));
		const wire = await Wire.install(page, pageRpc);
		const dialog = await openSystemLogs(page);
		await showRaw(dialog, wire);
		await chooseEverything(dialog, wire);
		rewritePage(wire, { hasMore: null, termination: 'budget' });
		rewritePage(wire, { hasMore: true, termination: 'lookahead' });
		await loadMore(dialog, wire);
		await expect(dialog.getByTestId('raw-keep-searching-bottom')).toBeFocused();

		const landed = wire.reply('logs.query');
		await page.keyboard.press('Enter');
		await landed;
		await expect(dialog.getByTestId('raw-load-more-bottom')).toBeFocused();
	});

	test('to Keep searching at the newer end of a window around a moment', async ({ page, pageRpc, backendRpc }) => {
		await Promise.all(Array.from({ length: 150 }, (_, index) => logMarker(backendRpc, `system-logs-newer-${index}`)));
		const wire = await Wire.install(page, pageRpc);
		const dialog = await openSystemLogs(page);
		const opened = wire.reply('logs.around');
		await deviceStarted(dialog).getByRole('button', { name: en['systemLogs.events.viewRaw'] }).click();
		await opened;
		rewritePage(wire, { hasMore: null, termination: 'budget' });
		await loadMore(dialog, wire, 'top');
		await expect(dialog.getByTestId('raw-keep-searching-top')).toBeFocused();
	});

	test('to a Raw logs row after the last page', async ({ page, pageRpc, backendRpc }) => {
		await Promise.all(Array.from({ length: 120 }, (_, index) => logMarker(backendRpc, `system-logs-last-${index}`)));
		const wire = await Wire.install(page, pageRpc);
		const dialog = await openSystemLogs(page);
		await showRaw(dialog, wire);
		await chooseEverything(dialog, wire);
		rewritePage(wire, { hasMore: false, termination: 'end' });
		await loadMore(dialog, wire);
		await expect(dialog.getByTestId('raw-end-bottom')).toBeVisible();
		await expect(dialog.getByTestId('raw-row').locator(':focus')).toHaveCount(1);
	});

	test('to an Events row after the last older page', async ({ page, pageRpc }) => {
		const wire = await Wire.install(page, pageRpc);
		claimOlderEvents(wire, 2);
		const dialog = await openSystemLogs(page);
		await loadOlderEvents(dialog, wire);
		await expect(dialog.getByRole('button', { name: en['systemLogs.events.loadOlder'] })).toBeFocused();
		await loadOlderEvents(dialog, wire);
		await expect(dialog.getByTestId('events-end')).toBeVisible();
		await expect(dialog.getByTestId('event-row').locator(':focus')).toHaveCount(1);
	});

	test('to Retry after an older Events page fails', async ({ page, pageRpc }) => {
		const wire = await Wire.install(page, pageRpc);
		claimOlderEvents(wire, 1);
		wire.rewriteNext('events.list', (frame) => ({ id: frame.id, error: { message: 'system-logs-older-failure' } }));
		const dialog = await openSystemLogs(page);
		await loadOlderEvents(dialog, wire);
		const retry = dialog.getByTestId('events-scroller').getByRole('button', { name: en['systemLogs.action.retry'] });
		await expect(retry).toBeFocused();

		const retried = wire.reply('events.list');
		await page.keyboard.press('Enter');
		await retried;
		await expect(dialog.getByTestId('events-end')).toBeVisible();
		await expect(dialog.getByTestId('event-row').locator(':focus')).toHaveCount(1);
	});

	test('to Reset filters after a search that ends without a match', async ({ page, pageRpc }) => {
		const wire = await Wire.install(page, pageRpc);
		const dialog = await openSystemLogs(page);
		await showRaw(dialog, wire);
		rewritePage(wire, { entries: [], hasMore: null, termination: 'budget' });
		rewritePage(wire, { entries: [], hasMore: false, termination: 'end' });
		const search = dialog.getByTestId('raw-search');
		const searched = wire.reply('logs.query');
		await search.fill(`system-logs-no-match-${test.info().project.name}`);
		await search.press('Enter');
		await searched;

		const landed = wire.reply('logs.query');
		await dialog.getByTestId('raw-keep-searching-bottom').focus();
		await page.keyboard.press('Enter');
		await landed;
		await expect(dialog.getByTestId('raw-reset-filters')).toBeFocused();
	});
});
