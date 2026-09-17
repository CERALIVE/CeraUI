import net from 'node:net';
import { test, expect } from './fixtures/index.js';
import { startWorkerBackend, workerBackendPort, type WorkerBackend } from './fixtures/backend.js';
import { BackendRpc } from './fixtures/backend-rpc.js';

test('an occupied port cannot impersonate the newly spawned backend', async () => {
	// Given a listener belonging to a different process/service.
	const incumbent = net.createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		incumbent.once('error', reject);
		incumbent.listen(0, '127.0.0.1', resolve);
	});
	const address = incumbent.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Expected a TCP listener');
	}
	let backend: WorkerBackend | undefined;
	try {
		// When the fixture is explicitly asked to bind the occupied port.
		const startup = startWorkerBackend({ port: address.port }).then((value) => {
			backend = value;
			return value;
		});
		// Then it must fail at startup, never hand the foreign service to a test.
		await expect(startup).rejects.toThrow(/worker backend startup failed/);
	} finally {
		await backend?.stop();
		await new Promise<void>((resolve, reject) => {
			incumbent.close((error) => error ? reject(error) : resolve());
		});
	}
});

test('concurrent backend acquisitions own distinct state and listeners', async () => {
	// CI deliberately routes only its fixed, isolated-runner 31xx range.
	const port = process.env.CI === 'true' ? workerBackendPort() : undefined;
	// Given two acquisitions in the same worker slot, as across local runs.
	const results = await Promise.allSettled([
		startWorkerBackend(port === undefined ? {} : { port }),
		startWorkerBackend(port === undefined ? {} : { port: port + 50 }),
	]);
	const backends = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
	try {
		for (const result of results) {
			if (result.status === 'rejected') throw result.reason;
		}
		// Then each owns a listener and an independently mutable device config.
		expect(backends).toHaveLength(2);
		expect(new Set(backends.map((backend) => backend.port)).size).toBe(2);
		expect(new Set(backends.map((backend) => backend.previewPort)).size).toBe(2);
		const clients: BackendRpc[] = [];
		try {
			for (const backend of backends) {
				clients.push(await BackendRpc.connect(backend.port, { proxySecret: backend.proxySecret }));
			}
			const [first, second] = clients;
			if (!first || !second) throw new Error('Expected two RPC clients');
			await first.call(['streaming', 'setConfig'], { max_br: 4200 });
			expect(await first.call(['streaming', 'getConfig'])).toMatchObject({ max_br: 4200 });
			expect(await second.call(['streaming', 'getConfig'])).not.toMatchObject({ max_br: 4200 });
		} finally {
			for (const client of clients) client.close();
		}
	} finally {
		await Promise.all(backends.map((backend) => backend.stop()));
	}
});
