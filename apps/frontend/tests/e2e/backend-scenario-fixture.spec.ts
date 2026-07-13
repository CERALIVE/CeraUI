import net from 'node:net';

import { expect, test } from './fixtures/index.js';
import { startWorkerBackend } from './fixtures/backend.js';

import { ensureAuthenticated } from './helpers/index.js';
import { installModemCapture, readModem0Lock } from './helpers/modem-capture.js';

interface RawUpgradeProbe {
	readonly closedPromptly: boolean;
	readonly elapsedMs: number;
}

function probeRawUpgradeTarget(
	port: number,
	requestTarget: string,
	cookie: string,
): Promise<RawUpgradeProbe> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		const socket = net.createConnection({ host: '127.0.0.1', port });
		let settled = false;
		const finish = (closedPromptly: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ closedPromptly, elapsedMs: performance.now() - startedAt });
		};
		const timer = setTimeout(() => finish(false), 1_000);
		socket.on('connect', () => {
			socket.write(
				[
					`GET ${requestTarget} HTTP/1.1`,
					`Host: 127.0.0.1:${port}`,
					'Connection: Upgrade',
					'Upgrade: websocket',
					'Sec-WebSocket-Version: 13',
					'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
					`Cookie: ${cookie}`,
					'',
					'',
				].join('\r\n'),
			);
		});
		socket.on('close', () => finish(true));
		socket.on('error', () => finish(true));
	});
}

/**
 * Fixture self-test for the per-worker `backendScenario` override
 * (fixtures/backend.ts + fixtures/index.ts). Proves that
 * `test.use({ backendScenario: 'modem-pin-locked' })` actually boots THIS
 * worker's backend on that MOCK_SCENARIO — the seeded PIN-locked modem surfaces
 * as `sim_lock.required === 'sim-pin'` in the modems broadcast. This is the
 * prerequisite infrastructure Todo 16's PIN-unlock e2e walk depends on: WS-proxy
 * state injection cannot fake RPC-handler-owned SIM state, so the walk needs a
 * backend genuinely booted on the modem-pin-locked scenario.
 *
 * `backendScenario` is a WORKER-scoped option (fixtures/index.ts), so the
 * override MUST be set at file top level — Playwright forbids a worker-option
 * `test.use` inside a `describe` ("forces a new worker"). The matching negative
 * control (a default-scenario worker does NOT report a PIN lock) therefore lives
 * in its own file, `backend-scenario-default.spec.ts`, so it runs in a separate
 * worker keyed on the default scenario.
 */
test.use({ backendScenario: 'modem-pin-locked' });

test('override worker: modem 0 SIM PIN-locked (sim_lock.required === "sim-pin")', async ({
	context,
	page,
	workerBackend,
}) => {
	await page.addInitScript(installModemCapture);
	await page.goto('/');
	await ensureAuthenticated(page);

	await expect
		.poll(() => readModem0Lock(page), {
			timeout: 20_000,
			message:
				'modem 0 should report sim_lock.required === "sim-pin" under the modem-pin-locked override',
		})
		.toBe('sim-pin');

	if (process.env.CI === 'true') {
		const cookieName = 'ceraui_e2e_backend_port';
		const previewOrigin = `http://localhost:${process.env.E2E_PORT ?? '6173'}`;
		const routingCookie = (await context.cookies(previewOrigin)).find(
			(cookie) => cookie.name === cookieName,
		);
		expect(routingCookie).toMatchObject({
			httpOnly: true,
			path: '/',
			sameSite: 'Strict',
			secure: false,
			value: `${workerBackend.port}.${workerBackend.proxySecret}`,
		});
		expect(await page.evaluate(() => document.cookie)).not.toContain(
			`${cookieName}=`,
		);

		const previewPort = Number.parseInt(process.env.E2E_PORT ?? '6173', 10);
		for (const rawTarget of [
			'/ws/../preview',
			'/ws/%2e%2e/preview',
			'/preview/./',
			'//evil/ws',
			'http://evil/ws',
			'/ws#fragment',
		]) {
			const probe = await probeRawUpgradeTarget(
				previewPort,
				rawTarget,
				`${cookieName}=${workerBackend.port}.${workerBackend.proxySecret}`,
			);
			expect(probe.closedPromptly, rawTarget).toBe(true);
			expect(probe.elapsedMs, rawTarget).toBeLessThan(1_000);
		}
		expect((await fetch(previewOrigin)).ok).toBe(true);
		const adjacentBackend = await startWorkerBackend({
			scenario: 'multi-modem-wifi',
			port: workerBackend.port + 50,
		});
		try {
			const directMutation = await page.evaluate(async (port) => {
				return new Promise<'mutated' | 'rejected'>((resolve) => {
					const socket = new WebSocket(`ws://localhost:${port}/ws`);
					const timeout = window.setTimeout(() => {
						socket.close();
						resolve('rejected');
					}, 5_000);
					const finish = (result: 'mutated' | 'rejected') => {
						window.clearTimeout(timeout);
						socket.close();
						resolve(result);
					};
					socket.addEventListener('open', () => {
						socket.send(
							JSON.stringify({
								id: 'cross-worker-login',
								path: ['auth', 'login'],
								input: {
									password: '12345678',
									persistent_token: false,
								},
							}),
						);
					});
					socket.addEventListener('message', (event) => {
						if (typeof event.data !== 'string') return;
						const frame: unknown = JSON.parse(event.data);
						if (typeof frame !== 'object' || frame === null || !('id' in frame)) {
							return;
						}
						if (frame.id === 'cross-worker-login') {
							socket.send(
								JSON.stringify({
									id: 'cross-worker-mutation',
									path: ['dev', 'emit'],
									input: {
										type: 'notification',
										payload: { show: [] },
									},
								}),
							);
						} else if (frame.id === 'cross-worker-mutation') {
							finish('mutated');
						}
					});
					socket.addEventListener('error', () => finish('rejected'));
					socket.addEventListener('close', () => finish('rejected'));
				});
			}, adjacentBackend.port);
			expect(directMutation).toBe('rejected');
		} finally {
			await adjacentBackend.stop();
		}
	}
});
