import fs from 'node:fs';
import path from 'node:path';
import { deviceStatsSchema } from '@ceraui/rpc/schemas';

import { expect, test } from '../fixtures/index.js';
import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from '../helpers/index.js';
import { SystemLogsPage } from '../pages/system-logs.js';

/**
 * Evidence captures of System Logs (not baselines; nothing is compared): Events,
 * Raw logs and Storage at 375, 768, 1280 and the 1024x600 kiosk in touch layout,
 * dark and light, English and Arabic, plus a message's View logs jump into an
 * approximate window, Japanese at 375, and the low-disk action's Storage focus.
 */

const OUT = path.join(EVIDENCE_DIR, 'system-logs');
const SIZES = [
	{ width: 375, height: 812, touch: false },
	{ width: 768, height: 1024, touch: false },
	{ width: 1280, height: 800, touch: false },
	{ width: 1024, height: 600, touch: true },
] as const;

for (const size of SIZES) {
	for (const scheme of ['dark', 'light'] as const) {
		for (const locale of ['en', 'ar'] as const) {
			const name = `${size.width}x${size.height}-${scheme}-${locale}`;
			test(`System Logs evidence ${name} @visual`, async ({ page }, testInfo) => {
				test.skip(testInfo.project.name !== 'desktop', 'each capture sets its own viewport, so it runs once');
				const logs = new SystemLogsPage(page);
				await logs.open({ locale, size, touch: size.touch, scheme });
				fs.mkdirSync(OUT, { recursive: true });
				for (const view of ['events', 'raw', 'storage'] as const) {
					await logs.show(view);
					await page.screenshot({ path: path.join(OUT, `${name}-${view}.png`) });
				}
			});
		}
	}
}

for (const size of [SIZES[0], SIZES[2]]) {
	for (const scheme of ['dark', 'light'] as const) {
		const name = `${size.width}x${size.height}-${scheme}-en`;
		test(`System Logs evidence ${name} View logs jump @visual`, async ({ page, pageRpc }, testInfo) => {
			test.skip(testInfo.project.name !== 'desktop', 'each capture sets its own viewport, so it runs once');
			const logs = new SystemLogsPage(page);
			await logs.open({ locale: 'en', size, touch: false, scheme });
			await page.keyboard.press('Escape');
			await pageRpc.call(['dev', 'emit'], {
				type: 'notification',
				payload: {
					show: [
						{
							name: 'evidence-view-logs',
							type: 'error',
							msg: 'Stream failed to start',
							key: 'notifications.streamStartInternalFailed',
							is_dismissable: true,
							is_persistent: false,
							duration: 60,
						},
					],
				},
			});
			await page.locator('[data-sonner-toast]').getByRole('button', { name: 'View logs' }).click();
			await expect(page.getByTestId('raw-anchor-approximate')).toBeVisible();
			const moment = page.getByTestId('raw-moment');
			const scroller = page.getByTestId('raw-scroller');
			// Newer entries can put the selected moment beyond the virtual list's initial rows.
			while ((await moment.count()) === 0) {
				const advanced = await scroller.evaluate(async (el) => {
					const before = el.scrollTop;
					el.scrollTop += el.clientHeight;
					await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
					return el.scrollTop > before;
				});
				if (!advanced) break;
			}
			await expect(moment).toBeVisible();
			await moment.scrollIntoViewIfNeeded();
			await expect(moment).toBeInViewport();
			await logs.settle();
			fs.mkdirSync(OUT, { recursive: true });
			await page.screenshot({ path: path.join(OUT, `${name}-view-logs-jump.png`) });
		});
	}
}

test('Japanese System Logs evidence capture @visual', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the capture sets its own viewport, so it runs once');
	const out = path.join(EVIDENCE_DIR, 'system-logs-responsive');
	const logs = new SystemLogsPage(page);
	await logs.open({ locale: 'ja', size: { width: 375, height: 812 }, touch: false, scheme: 'dark' });
	fs.mkdirSync(out, { recursive: true });
	for (const view of ['events', 'raw', 'storage'] as const) {
		await logs.show(view);
		await page.screenshot({ path: path.join(out, `ja-375-${view}.png`) });
	}
});

test('the low-disk action opens wide Storage with keyboard focus, evidence @visual', async ({ page, pageRpc }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the wide Storage column needs the desktop viewport');
	const disk = { used: 1_000_000_000, total: 1_100_000_000, type: 'SSD' } as const;
	// Every stats broadcast keeps the low disk, so a periodic one cannot hide the banner before Enter.
	await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
		const server = socket.connectToServer();
		pageRpc.bindConnectionLifecycle(socket, server);
		socket.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const frame = typeof message === 'string' ? JSON.parse(message) : undefined;
			const out = frame?.['device-stats'] === undefined ? message : JSON.stringify({ ...frame, 'device-stats': { ...frame['device-stats'], disk } });
			socket.send(out);
			pageRpc.acceptServerMessage(out);
		});
	});
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'settings');
	await pageRpc.call(['dev', 'emit'], {
		type: 'device-stats',
		payload: deviceStatsSchema.parse({ disk, cpuLoad1: null, socTemp: null, ifaceRxTx: null, raucSlot: 'a' }),
	});
	await page.getByTestId('low-disk-view-logs').focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	await expect(dialog.getByTestId('system-logs-storage').getByRole('heading', { name: 'Storage', exact: true })).toBeFocused();
	fs.mkdirSync(path.join(EVIDENCE_DIR, 'view-logs-focus'), { recursive: true });
	await page.screenshot({ path: path.join(EVIDENCE_DIR, 'view-logs-focus/storage-1280.png') });
});
