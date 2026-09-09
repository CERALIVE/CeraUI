import type { ConfigMessage, Modem, NotificationsMessage } from '@ceraui/rpc/schemas';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated } from './helpers/index.js';

// Default mode keeps these independent tests on one worker even with fullyParallel.
// Each successor must get a fresh baseline, not compensate for its predecessor.
test.describe('backend isolation between tests', () => {
	test.describe.configure({ mode: 'default' });
	let previousSecret: string;

	test('a real modem save raises a persistent roaming advisory', async ({
		backendRpc,
		workerBackend,
	}) => {
		test.setTimeout(60_000);
		previousSecret = workerBackend.proxySecret;
		await expect.poll(async () => {
			const modems = await backendRpc.call<Record<string, Modem>>(['modems', 'getAll']);
			return modems['0']?.config !== undefined;
		}).toBe(true);
		const modems = await backendRpc.call<Record<string, Modem>>(['modems', 'getAll']);
		const modem = modems['0'];
		if (!modem?.config || !modem.network_type.active) throw new Error('seeded modem missing');

		const result = await backendRpc.call(['modems', 'configure'], {
			...modem.config,
			device: '0',
			network_type: modem.network_type.active,
			roaming: true,
		});
		expect(result).toMatchObject({ success: true });
		await expect.poll(async () => {
			const notifications = await backendRpc.call<NotificationsMessage>(['notifications', 'getPersistent']);
			return notifications.show?.some((notice) => notice.name.startsWith('modem_roaming:')) ?? false;
		}, { timeout: 40_000 }).toBe(true);
	});

	test('a backend-only test starts clean and can persist its own config', async ({
		backendRpc,
		workerBackend,
	}) => {
		expect(workerBackend.proxySecret).not.toBe(previousSecret);
		previousSecret = workerBackend.proxySecret;
		expect(await backendRpc.call(['notifications', 'getPersistent'])).toEqual({ show: [] });
		await expect.poll(async () => {
			const modems = await backendRpc.call<Record<string, Modem>>(['modems', 'getAll']);
			return modems['0']?.status?.roaming;
		}).toBe(false);
		expect(await backendRpc.call(['streaming', 'setConfig'], {
			srt_streamid: 'isolation-predecessor',
		})).toMatchObject({ success: true });
	});

	test('a fresh page inherits neither device notifications nor persisted config', async ({
		page,
		backendRpc,
		workerBackend,
	}) => {
		expect(workerBackend.proxySecret).not.toBe(previousSecret);
		const config = await backendRpc.call<ConfigMessage>(['streaming', 'getConfig']);
		expect(config.srt_streamid).not.toBe('isolation-predecessor');
		await page.goto('/');
		await ensureAuthenticated(page);
		await expect(page.getByTestId('notifications-unread-count')).toHaveCount(0);
		await page.getByTestId('notifications-bell').click();
		await expect(page.getByTestId('notifications-empty')).toBeVisible();
	});
});
