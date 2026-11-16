import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { type LogQueryInput, deviceStatsSchema, logAroundOutputSchema, logQueryInputSchema } from '@ceraui/rpc/schemas';

import { expect, type PageRpc, test } from './fixtures/index.js';

import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from './helpers/index.js';

const exports = new WeakMap<Page, { promise: Promise<unknown>; resolve(value: unknown): void }>();
const exactAnchor = new WeakSet<Page>();
const lowDisk = new WeakSet<Page>();
const queries = new WeakMap<Page, LogQueryInput[]>();

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
		pageRpc.bindConnectionLifecycle(socket, server);
		socket.onMessage(message => {
			server.send(message);
			if (typeof message !== 'string') return;
			const frame = JSON.parse(message);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.createExport')
				exported.resolve(frame.input);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.around')
				aroundIds.add(frame.id);
			if (Array.isArray(frame.path) && frame.path.join('.') === 'logs.query')
				reads.push(logQueryInputSchema.parse(frame.input));
		});
		server.onMessage(message => {
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

test('the low-disk action opens wide Storage with keyboard focus @visual', async ({ page, pageRpc }) => {
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
	fs.mkdirSync(path.join(EVIDENCE_DIR, 'view-logs-focus'), { recursive: true });
	await page.screenshot({ path: path.join(EVIDENCE_DIR, 'view-logs-focus/storage-1280.png') });
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
	await expect(logs.getByTestId('raw-row').filter({ hasText: marker }).first()).toBeVisible();
	await expect(logs.getByRole('tab', { name: 'Raw logs' })).toBeFocused();
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
