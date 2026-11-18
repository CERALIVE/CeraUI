import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, runWithStdin } from '../../../src/helpers/run.ts';
import { installNativeNmcliShim } from './first-ap-nmcli-shim.ts';
import { probeNetworkManager } from './guest-preflight-nm.ts';
import { waitForManagedWifiDevice } from './hybrid-readiness.ts';
import { canonicalIwPhy } from './observations.ts';

const secret = `preflight-${crypto.randomUUID()}`;
const results: {
	readonly name: string;
	readonly passed: boolean;
	readonly detail: string;
}[] = [];
async function probe(name: string, check: () => Promise<void>): Promise<void> {
	try {
		await check();
		results.push({ name, passed: true, detail: '' });
		process.stdout.write(`HWSIM-PREFLIGHT: ${name} PASS\n`);
	} catch (error: unknown) {
		const detail = (error instanceof Error ? error.message : String(error)).replaceAll(
			secret,
			'<redacted>',
		);
		results.push({ name, passed: false, detail });
		process.stdout.write(`HWSIM-PREFLIGHT: ${name} FAIL ${detail}\n`);
	}
}
const cli = (args: string[]) => run('nmcli', args, { timeout: 3000, maxBuffer: 65536 });

await probe('native-boundary', async () => {
	assert.equal(process.getuid?.(), 0);
	assert.equal(process.env.HWSIM_REPO, '/repo');
	assert.equal(await realpath(process.cwd()), '/repo');
	assert.equal(process.env.NODE_ENV, 'production');
	assert.equal(process.env.MOCK_MODE, 'false');
	assert.equal(process.env.LC_ALL, 'C');
});
if (results.some((result) => !result.passed)) process.exit(1);

await probe('backend-imports', async () => {
	for (const name of [
		'./first-ap-saved-profile.ts',
		'./first-ap-edit-race.ts',
		'./first-ap-recovery.ts',
	])
		await import(new URL(name, import.meta.url).href);
	const { shouldUseMocks } = await import('../../../src/mocks/mock-service.ts');
	assert.equal(shouldUseMocks(), false);
});
await probe('check-syntax', async () => {
	const transpiler = new Bun.Transpiler({ loader: 'ts' });
	for (const name of await readdir(import.meta.dir))
		if (name.endsWith('.ts'))
			transpiler.transformSync(await readFile(join(import.meta.dir, name), 'utf8'));
});
await probe('state-filesystem', async () => {
	const root = await mkdtemp(join(process.cwd(), '.hwsim-preflight-state-'));
	try {
		const { writeFileAtomicSync } = await import('../../../src/helpers/config-loader.ts');
		const blocked = join(root, 'write-is-a-directory');
		await mkdir(blocked);
		assert.throws(() => writeFileAtomicSync(blocked, '{}'), { code: 'EISDIR' });
		const file = join(root, 'config.json');
		writeFileAtomicSync(file, '{"intent":"hybrid"}');
		assert.equal(await readFile(file, 'utf8'), '{"intent":"hybrid"}');
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
await probe('websocket-loopback', async () => {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, listener) {
			return listener.upgrade(request) ? undefined : new Response(null, { status: 400 });
		},
		websocket: {
			message(socket, message) {
				socket.send(message);
			},
		},
	});
	const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
	const reply = Promise.withResolvers<string>();
	const deadline = setTimeout(() => reply.reject(new Error('Loopback WebSocket timed out')), 2000);
	client.onopen = () => client.send('preflight');
	client.onmessage = (event) => reply.resolve(String(event.data));
	client.onerror = () => reply.reject(new Error('Loopback WebSocket failed'));
	try {
		assert.equal(await reply.promise, 'preflight');
	} finally {
		clearTimeout(deadline);
		client.close();
		await server.stop(true);
	}
});

let shim: Awaited<ReturnType<typeof installNativeNmcliShim>> | undefined;
await probe('shim-install', async () => {
	shim = await installNativeNmcliShim(secret);
});
try {
	for (const route of ['run', 'runWithStdin'] as const)
		await probe(`shim-${route}`, async () => {
			assert(shim, 'Shim installation failed');
			const before = (await shim.events()).length;
			if (route === 'run') await cli(['--version']);
			else
				await runWithStdin('nmcli', ['--version'], '', {
					timeout: 3000,
					maxBuffer: 4096,
				});
			const events = await shim.events();
			process.stdout.write(
				`HWSIM-PREFLIGHT: route=${route} receipts-before=${before} receipts-after=${events.length}\n`,
			);
			assert.equal(events.length - before, 1);
		});
	await probe('explicit-child-environment', async () => {
		const child = Bun.spawn(
			[process.execPath, '-e', 'process.stdout.write(process.env.HWSIM_PREFLIGHT_CHILD ?? "")'],
			{
				env: { ...process.env, HWSIM_PREFLIGHT_CHILD: 'inherited' },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 3000,
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		assert.deepEqual({ stdout, stderr, code }, { stdout: 'inherited', stderr: '', code: 0 });
	});

	const radios: string[] = [];
	await probe('four-clean-radios', async () => {
		const macs = new Set<string>();
		for (const name of (await readdir('/sys/class/net')).sort()) {
			const phy = await realpath(`/sys/class/net/${name}/phy80211`).catch(() => '');
			if (!phy.includes('/mac80211_hwsim/')) continue;
			radios.push(name);
		}
		const observations: { readonly phy: string; readonly raw: string }[] = [];
		for (const name of radios) {
			const phy = await realpath(`/sys/class/net/${name}/phy80211`);
			const id = phy.split('/').at(-1) ?? '';
			const raw = await run('iw', ['phy', id, 'info']);
			const directory = process.argv[2];
			if (!directory) throw new Error('Missing observation receipt directory');
			await writeFile(join(directory, `iw-${id}-info.txt`), raw, { mode: 0o600 });
			observations.push({ phy, raw });
		}
		for (const { phy, raw } of observations) {
			const mac = (await readFile(`${phy}/macaddress`, 'utf8')).trim().toLowerCase();
			assert(!macs.has(mac), 'Duplicate permanent radio MAC');
			macs.add(mac);
			const info = canonicalIwPhy(raw);
			assert.match(info, /\* AP\b/);
			assert.match(info, /2437 MHz \[6\](?![^\n]*disabled)/);
		}
		assert.equal(radios.length, 4);
	});
	const ready = async (stage: string) => {
		for (const device of radios.slice(1))
			await probe(`${stage}-${device}`, async () => {
				await waitForManagedWifiDevice(
					device,
					'nmcli',
					(argv, _env, signal) => run('nmcli', argv.slice(1), { signal, timeout: 3000 }),
					(text) => text,
					AbortSignal.timeout(3000),
				);
			});
	};
	await ready('ready');
	await probe('virtual-interface-create-delete', async () => {
		const parent = radios[1];
		assert(parent, 'Missing parent radio');
		const name = `pf-${crypto.randomUUID().slice(0, 8)}`;
		await run('iw', ['dev', parent, 'interface', 'add', name, 'type', 'managed']);
		try {
			assert((await realpath(`/sys/class/net/${name}/phy80211`)).includes('/mac80211_hwsim/'));
		} finally {
			await run('iw', ['dev', name, 'del']);
		}
	});

	await probeNetworkManager(probe, radios[2]);
	await ready('ready-after-restart');
} finally {
	await probe('shim-close', async () => {
		await shim?.close();
	});
}
await probe('receipt-fsync', async () => {
	const directory = process.argv[2];
	assert(directory, 'Missing preflight receipt directory');
	const file = await open(join(directory, 'native.json'), 'wx', 0o600);
	try {
		await file.writeFile(JSON.stringify(results));
		await file.sync();
	} finally {
		await file.close();
	}
	const parent = await open(directory, 'r');
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
});
process.exit(results.some((result) => !result.passed) ? 1 : 0);
