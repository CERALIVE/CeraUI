import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import type { PageRpc } from './fixtures/page-rpc.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { type SystemLogsTab, SystemLogsPage } from './pages/system-logs.js';

/**
 * The logs toolbar's Support bundle and Export logs stay fully in view, without
 * scrolling, on every tab of every layout (phone, tablet, touch kiosk, desktop
 * and e-ink), and a phone exports from Events, where Downloads is not mounted.
 */

const LAYOUTS = [
	{ name: 'phone', size: { width: 375, height: 812 }, touch: false, eink: false, thumb: true },
	{ name: 'tablet', size: { width: 768, height: 1024 }, touch: false, eink: false, thumb: false },
	{ name: 'kiosk', size: { width: 1024, height: 600 }, touch: true, eink: false, thumb: true },
	{ name: 'desktop', size: { width: 1280, height: 800 }, touch: false, eink: false, thumb: false },
	{ name: 'e-ink phone', size: { width: 375, height: 812 }, touch: false, eink: true, thumb: true },
] as const;

type Frame = { readonly id?: unknown; readonly path?: unknown; readonly input?: unknown; result?: unknown };

function frameOf(message: string | Buffer): Frame | undefined {
	if (typeof message !== 'string') return undefined;
	const value: unknown = JSON.parse(message);
	return typeof value === 'object' && value !== null ? value : undefined;
}

/**
 * Passes the app's socket through, records each logs.createExport input, refuses
 * `refuse` with READ_FAILED and adds `boots` to the device's logs.boots reply.
 */
async function routeLogs(
	page: Page,
	pageRpc: PageRpc,
	refuse: readonly string[] = [],
	boots: readonly unknown[] = [],
	delayExport?: (refuseExport: () => void) => void,
): Promise<unknown[]> {
	const exports: unknown[] = [];
	const bootReads = new Set<unknown>();
	await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
		const server = socket.connectToServer();
		pageRpc.bindConnectionLifecycle(socket, server);
		socket.onMessage((message) => {
			const frame = frameOf(message);
			const path = Array.isArray(frame?.path) ? frame.path.join('.') : '';
			if (path === 'logs.createExport') exports.push(frame?.input);
			if (path === 'logs.createExport' && delayExport) {
				delayExport(() => socket.send(JSON.stringify({
					id: frame?.id, error: { message: 'CREDENTIALS_LOADING', code: 'INTERNAL_ERROR' },
				})));
				return;
			}
			if (path === 'logs.boots') bootReads.add(frame?.id);
			if (refuse.includes(path)) {
				socket.send(JSON.stringify({ id: frame?.id, error: { message: 'READ_FAILED', code: 'INTERNAL_ERROR' } }));
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = frameOf(message);
			if (frame && bootReads.has(frame.id) && Array.isArray(frame.result)) {
				frame.result = [...frame.result, ...boots];
				message = JSON.stringify(frame);
			}
			socket.send(message);
			pageRpc.acceptServerMessage(message);
		});
	});
	return exports;
}

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };

async function openFailedLogs(page: Page, size: { width: number; height: number } = PHONE): Promise<void> {
	await page.setViewportSize(size);
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	await page.getByTestId('settings-entry-logs').click();
}

test.describe('System Logs toolbar', { tag: '@desktop-only' }, () => {
	for (const layout of LAYOUTS) {
		test(`keeps Support bundle and Export logs in view on every tab, ${layout.name}`, async ({ page }) => {
			if (layout.eink) {
				await page.addInitScript(() => localStorage.setItem('display-profile', JSON.stringify('eink')));
			}
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size: layout.size, touch: layout.touch, scheme: 'dark' });
			if (layout.eink) await expect(page.locator('html')).toHaveAttribute('data-display', 'eink');

			const toolbar = page.getByRole('group', { name: 'Downloads' });
			const tabs: SystemLogsTab[] = layout.size.width >= 1024 ? ['events', 'raw'] : ['events', 'raw', 'storage'];
			for (const tab of tabs) {
				await logs.show(tab);
				for (const name of ['Support bundle', 'Export logs']) {
					const action = toolbar.getByRole('button', { name, exact: true });
					await expect(action).toBeInViewport({ ratio: 1 });
					// A phone is thumbed and the kiosk is touch, so both get the 44 px target.
					if (layout.thumb) expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
				}
			}
		});
	}

	for (const action of [
		{ row: 'sharing-open-export', toolbar: 'Export logs', dialog: 'Export this view' },
		{ row: 'sharing-open-bundle', toolbar: 'Support bundle', dialog: 'Support bundle' },
	] as const) {
		test(`returns focus to the toolbar's ${action.toolbar} when a resize removed the Downloads row that opened ${action.dialog}`, async ({ page }) => {
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size: { width: 1280, height: 800 }, touch: false, scheme: 'dark' });
			const row = page.getByTestId(action.row);
			await row.focus();
			await page.keyboard.press('Enter');
			const dialog = page.getByRole('dialog', { name: action.dialog });
			await expect(dialog).toBeVisible();

			// Below 1024 px Downloads moves into the Storage tab, which is not the open one.
			await page.setViewportSize({ width: 375, height: 812 });
			await expect(row).toHaveCount(0);
			await expect(dialog).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);

			await expect(
				page.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: action.toolbar, exact: true }),
			).toBeFocused();
		});
	}

	for (const action of [
		{ row: 'sharing-open-export', toolbar: 'Export logs', dialog: 'Export this view' },
		{ row: 'sharing-open-bundle', toolbar: 'Support bundle', dialog: 'Support bundle' },
	] as const) {
		test(`returns focus to the toolbar's ${action.toolbar} when widening moved the phone's Storage row that opened ${action.dialog}`, async ({ page }) => {
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size: { width: 375, height: 812 }, touch: false, scheme: 'dark' });
			await logs.show('storage');
			const opener = await page.getByTestId(action.row).elementHandle();
			await page.getByTestId(action.row).focus();
			await page.keyboard.press('Enter');
			const dialog = page.getByRole('dialog', { name: action.dialog });
			await expect(dialog).toBeVisible();

			// From 1024 px Downloads renders in the side column: the row that opened the dialog is replaced.
			await page.setViewportSize({ width: 1280, height: 800 });
			await expect(page.getByTestId('system-logs-side').getByTestId(action.row)).toBeVisible();
			expect(await opener?.evaluate((node) => node.isConnected)).toBe(false);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);

			await expect(
				page.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: action.toolbar, exact: true }),
			).toBeFocused();
		});
	}

	test('a phone gets 44 px Try again and Support bundle when System Logs cannot load', async ({ page, pageRpc }) => {
		await routeLogs(page, pageRpc, ['logs.getStorage']);
		await openFailedLogs(page);

		const band = page.getByTestId('system-logs-check-failed');
		for (const name of ['Try again', 'Support bundle']) {
			const action = band.getByRole('button', { name, exact: true });
			await expect(action).toBeInViewport({ ratio: 1 });
			expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		}
		await band.getByRole('button', { name: 'Support bundle', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Support bundle' }).getByTestId('sharing-bundle-sensitive')).toBeVisible();
	});

	test('a phone opens the explained support bundle and exports from Events', async ({ page }, testInfo) => {
		const logs = new SystemLogsPage(page);
		await logs.open({ locale: 'en', size: { width: 375, height: 812 }, touch: false, scheme: 'light' });
		await expect(page.getByTestId('sharing-group')).toHaveCount(0);
		const toolbar = page.getByRole('group', { name: 'Downloads' });

		await toolbar.getByRole('button', { name: 'Support bundle', exact: true }).click();
		const bundle = page.getByRole('dialog', { name: 'Support bundle' });
		await expect(bundle.getByTestId('sharing-bundle-about')).toHaveText(
			'One file for a helper: versions, events, recent logs and settings, with known secrets removed.',
		);
		await expect(bundle.getByTestId('sharing-bundle-sensitive')).toBeVisible();
		await expect(bundle.getByRole('button', { name: 'Download bundle' })).toBeEnabled();
		await bundle.getByRole('button', { name: 'Cancel' }).click();
		await expect(bundle).toHaveCount(0);

		await toolbar.getByRole('button', { name: 'Export logs', exact: true }).click();
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		await expect(confirm.getByTestId('sharing-export-sensitive')).toBeVisible();
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			confirm.getByRole('button', { name: 'Download export' }).click(),
		]);
		const file = testInfo.outputPath('export.txt');
		await download.saveAs(file);
		const text = await readFile(file, 'utf8');
		expect(text.slice(0, 15).toLowerCase()).not.toBe('<!doctype html>');
		// The device's own export file: its header lines, then the entry count footer.
		expect(text).toMatch(/^# /);
		expect(text).toMatch(/^# (complete: \d+ entries|incomplete: .+)$/m);
		expect(download.suggestedFilename()).toMatch(/\.txt$/);
	});

	test('a phone returns focus to the failure band after a refused support bundle hands off to Export this view', async ({ page, pageRpc }) => {
		await routeLogs(page, pageRpc, ['logs.getStorage', 'logs.previewBundle']);
		await openFailedLogs(page);
		const bandBundle = page.getByTestId('system-logs-check-failed').getByRole('button', { name: 'Support bundle', exact: true });
		const bundle = page.getByRole('dialog', { name: 'Support bundle' });
		await bandBundle.click();
		await expect(bundle.getByRole('button', { name: 'Export this view', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(bundle).toHaveCount(0);
		await expect(bandBundle).toBeFocused();

		await bandBundle.click();
		await bundle.getByRole('button', { name: 'Export this view', exact: true }).click();
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		await expect(confirm).toBeVisible();
		await expect(bundle).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(confirm).toHaveCount(0);
		await expect(page.getByRole('group', { name: 'Downloads' })).toHaveCount(0);
		await expect(bandBundle).toBeFocused();
	});

	for (const size of [PHONE, DESKTOP]) {
		test(`keeps the keyboard in a refused export and restores the opener at ${size.width}px`, async ({ page, pageRpc }) => {
			const pending = Promise.withResolvers<() => void>();
			const exports = await routeLogs(page, pageRpc, [], [], pending.resolve);
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size, touch: false, scheme: 'light' });

			const trigger = page.getByRole('button', { name: 'Export logs', exact: true });
			await trigger.focus();
			await page.keyboard.press('Enter');
			const confirm = page.getByRole('dialog', { name: 'Export this view' });
			const download = confirm.getByRole('button', { name: 'Download export' });
			const cancel = confirm.getByRole('button', { name: 'Cancel' });
			const close = confirm.getByTestId('app-dialog-close');
			await download.focus();
			await page.keyboard.press('Enter');
			const refuse = await pending.promise;
			await expect(download).toBeDisabled();
			await expect(cancel).toBeFocused();
			refuse();
			await expect(confirm.getByRole('alert')).toBeVisible();
			await expect(cancel).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(download).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(close).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(download).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(confirm).toHaveCount(0);
			await expect(trigger).toBeFocused();
			expect(exports).toHaveLength(1);
		});
	}

	test('a phone returns focus to the control that had it when a pointer opened the failure band dialogs without focusing (Safari default)', async ({ page, pageRpc }) => {
		await routeLogs(page, pageRpc, ['logs.getStorage', 'logs.previewBundle']);
		await openFailedLogs(page);
		const band = page.getByTestId('system-logs-check-failed');
		const tryAgain = band.getByRole('button', { name: 'Try again', exact: true });
		const bandBundle = band.getByRole('button', { name: 'Support bundle', exact: true });
		const bundle = page.getByRole('dialog', { name: 'Support bundle' });
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		await tryAgain.focus();
		// dispatchEvent clicks without moving focus, as WebKit does for a pointer press on a button.
		await bandBundle.dispatchEvent('click');
		await expect(bundle).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(bundle).toHaveCount(0);
		await expect(tryAgain).toBeFocused();

		await bandBundle.dispatchEvent('click');
		await bundle.getByRole('button', { name: 'Export this view', exact: true }).dispatchEvent('click');
		await expect(confirm).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(confirm).toHaveCount(0);
		await expect(tryAgain).toBeFocused();
	});

	for (const move of [
		{
			name: 'widening to desktop removes the phone header boot picker that had focus',
			from: PHONE,
			to: DESKTOP,
			opener: (page: Page) => page.getByRole('dialog', { name: 'System Logs' }).getByRole('button', { name: /^Choose a boot/ }),
		},
		{
			name: 'narrowing to a phone removes the side column control that had focus',
			from: DESKTOP,
			to: PHONE,
			opener: (page: Page) => page.getByTestId('system-logs-side').getByRole('button').first(),
		},
	] as const) {
		for (const handoff of [false, true]) {
			test(`returns focus to the failure band's Support bundle, never the page, when ${move.name}${handoff ? ', after the refused-bundle handoff' : ''}`, async ({ page, pageRpc }) => {
				await routeLogs(page, pageRpc, ['logs.getStorage', 'logs.previewBundle']);
				await openFailedLogs(page, move.from);
				const opener = move.opener(page);
				await opener.focus();
				await expect(opener).toBeFocused();
				const bandBundle = page.getByTestId('system-logs-check-failed').getByRole('button', { name: 'Support bundle', exact: true });
				const bundle = page.getByRole('dialog', { name: 'Support bundle' });
				const confirm = page.getByRole('dialog', { name: 'Export this view' });
				// A pointer press that leaves focus where it was (WebKit), so the dialog's opener is the moving control.
				await bandBundle.dispatchEvent('click');
				if (handoff) await bundle.getByRole('button', { name: 'Export this view', exact: true }).dispatchEvent('click');
				const open = handoff ? confirm : bundle;
				await expect(open).toBeVisible();

				await page.setViewportSize(move.to);
				await expect(move.opener(page)).toHaveCount(0);
				await page.keyboard.press('Escape');
				await expect(open).toHaveCount(0);

				await expect(bandBundle).toBeFocused();
				expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
			});
		}
	}

	test('Export logs states and sends each boot picked in the real picker, a previous one included', async ({ page, pageRpc }) => {
		const previous = {
			bootId: '5e0f6b1c2d3a49e88f7a6b5c4d3e2f10', index: 1, current: false, shutdown: 'clean',
			firstTs: Date.now() - 3 * 86_400_000, lastTs: Date.now() - 2 * 86_400_000,
			evidence: [], logsAvailable: true, versions: null,
		};
		// Refused tickets keep the confirmation open, so each frame is read and the dialog cancelled.
		const exports = await routeLogs(page, pageRpc, ['logs.createExport'], [previous]);
		const logs = new SystemLogsPage(page);
		await logs.open({ locale: 'en', size: { width: 1280, height: 800 }, touch: false, scheme: 'dark' });
		const picker = page.getByTestId('boot-picker');
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		const exportWith = async (boot: string) => {
			await page.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true }).click();
			await expect(confirm.getByTestId('sharing-export-scope').locator('dt, dd')).toHaveText([
				'Boots', boot, 'Level', 'Info', 'Sources', 'All sources',
			]);
			await confirm.getByRole('button', { name: 'Download export' }).click();
			await expect(confirm.getByTestId('sharing-export-problem')).toBeVisible();
			await confirm.getByRole('button', { name: 'Cancel' }).click();
			await expect(confirm).toHaveCount(0);
			return exports.at(-1);
		};
		const opening = { sources: [], levels: ['error', 'warning', 'info'] };
		const earlier = picker.locator(`[data-boot-id="${previous.bootId}"]`);
		const running = picker.locator(`[data-testid="boot-option"]:not([data-boot-id="${previous.bootId}"])`);

		await earlier.click();
		const started = (await earlier.locator('time').textContent())?.trim() ?? '';
		expect(started).toMatch(/^Boot started /);
		expect(await exportWith(started)).toEqual({ filter: opening, boot: previous.bootId });
		await running.click();
		expect(await exportWith('This boot')).toEqual({ filter: opening, boot: 'current' });
		await picker.getByTestId('boot-option-all').click();
		expect(await exportWith('All boots')).toEqual({ filter: opening, boot: 'all' });
		expect(exports).toHaveLength(3);
	});

	test('Export logs states and saves the boots chosen: all boots on Events, this boot and its search on Raw, Raw\'s kept search until All boots is picked', async ({ page, pageRpc }) => {
		const exports = await routeLogs(page, pageRpc);
		const logs = new SystemLogsPage(page);
		await logs.open({ locale: 'en', size: { width: 1280, height: 800 }, touch: false, scheme: 'dark' });
		const confirm = page.getByRole('dialog', { name: 'Export this view' });
		const exportLogs = page.getByRole('group', { name: 'Downloads' }).getByRole('button', { name: 'Export logs', exact: true });
		const exportWith = async (scope: readonly string[]) => {
			await exportLogs.click();
			await expect(confirm.getByTestId('sharing-export-scope').locator('dt, dd')).toHaveText(scope);
			await Promise.all([page.waitForEvent('download'), confirm.getByRole('button', { name: 'Download export' }).click()]);
			await expect(confirm).toHaveCount(0);
			await expect(exportLogs).toBeFocused();
			return exports.at(-1);
		};
		const marker = 'scope-marker';
		const opening = { sources: [], levels: ['error', 'warning', 'info'] };
		const levels = ['Level', 'Info', 'Sources', 'All sources'];
		const searched = [...levels, 'Search messages', marker];

		expect(await exportWith(['Boots', 'All boots', ...levels])).toEqual({ filter: opening, boot: 'all' });

		await logs.show('raw');
		await page.getByTestId('raw-search').fill(marker);
		await page.getByTestId('raw-search').press('Enter');
		expect(await exportWith(['Boots', 'This boot', ...searched])).toEqual({ filter: { ...opening, text: marker }, boot: 'current' });

		await logs.show('events');
		expect(await exportWith(['Boots', 'This boot', ...searched])).toEqual({ filter: { ...opening, text: marker }, boot: 'current' });
		await page.getByTestId('boot-option-all').click();
		expect(await exportWith(['Boots', 'All boots', ...searched])).toEqual({ filter: { ...opening, text: marker }, boot: 'all' });
		expect(exports).toHaveLength(4);
	});
});
