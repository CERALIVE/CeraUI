import assert from 'node:assert/strict';
import type { BigIntStats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { run, runWithStdin } from '../../../src/helpers/run.ts';

/** Exercise the guest's shared-AP dependencies and NM's CLI/file/bus contract. */
export async function probeNetworkManager(
	probe: (name: string, check: () => Promise<void>) => Promise<void>,
	radio: string | undefined,
): Promise<void> {
	const cli = (args: string[]) => run('nmcli', args, { timeout: 3000, maxBuffer: 65536 });
	const ap = crypto.randomUUID();
	let apCreated = false;
	await probe('shared-ap-create', async () => {
		assert(radio, 'Missing AP control radio');
		await cli([
			'con',
			'add',
			'type',
			'wifi',
			'ifname',
			radio,
			'connection.uuid',
			ap,
			'con-name',
			`CeraPreflight-${ap}`,
			'ssid',
			`CeraPreflight-${ap.slice(0, 8)}`,
			'connection.autoconnect',
			'no',
			'wifi.mode',
			'ap',
			'wifi.band',
			'bg',
			'wifi.channel',
			'6',
			'wifi-sec.key-mgmt',
			'wpa-psk',
			'wifi-sec.psk',
			'ceratest1234',
			'ipv4.method',
			'shared',
			'ipv6.method',
			'ignore',
		]);
		apCreated = true;
	});
	try {
		await probe('shared-ap-runtime', async () => {
			assert(apCreated && radio, 'AP control creation failed');
			await run('nmcli', ['-w', '10', 'con', 'up', 'uuid', ap], { timeout: 12000 });
			assert.match(await run('iw', ['dev', radio, 'info']), /\btype AP\b/);
			const state = await cli(['-g', 'GENERAL.STATE,GENERAL.CON-UUID', 'dev', 'show', radio]);
			assert.equal(Number.parseInt(state.split('\n')[0] ?? '', 10), 100);
			assert.equal(state.split('\n')[1], ap);
		});
	} finally {
		await probe('shared-ap-cleanup', async () => {
			if (apCreated) await cli(['con', 'delete', 'uuid', ap]);
		});
	}
	const uuid = crypto.randomUUID();
	const name = `CeraPreflight-${uuid}`;
	let created = false;
	let persisted:
		| {
				readonly filename: string;
				readonly path: string;
				readonly info: BigIntStats;
				readonly bytes: Buffer;
		  }
		| undefined;
	await probe('nm-profile-create', async () => {
		await cli([
			'con',
			'add',
			'type',
			'dummy',
			'ifname',
			'cera-preflight',
			'connection.uuid',
			uuid,
			'connection.id',
			name,
			'connection.autoconnect',
			'no',
			'ipv4.method',
			'disabled',
			'ipv6.method',
			'disabled',
		]);
		created = true;
	});
	try {
		for (const trailing of ['', '\n'])
			await probe(`nm-framing-${trailing ? 'trailing-lf' : 'plain'}`, async () => {
				assert(created, 'Profile creation failed');
				await cli(['con', 'modify', 'uuid', uuid, 'connection.id', name + trailing]);
				assert.equal(
					await cli([
						'--mode',
						'multiline',
						'--terse',
						'--escape',
						'no',
						'--fields',
						'connection.id,connection.autoconnect',
						'con',
						'show',
						'uuid',
						uuid,
					]),
					`connection.id:${name}${trailing}\nconnection.autoconnect:no\n`,
				);
			});
		await probe('profile-file-dbus-path', async () => {
			assert(created, 'Profile creation failed');
			const { nmcliParseSep } = await import('../../../src/modules/network/network-manager.ts');
			const row = (await cli(['-t', '-f', 'UUID,FILENAME,DBUS-PATH', 'con', 'show']))
				.split('\n')
				.map((line) => nmcliParseSep(line))
				.find(([id]) => id === uuid);
			const [, filename, path] = row ?? [];
			assert(filename && path, 'Missing persisted filename or D-Bus path');
			assert.match(path, /^\/org\/freedesktop\/NetworkManager\/Settings\/\d+$/);
			persisted = {
				filename,
				path,
				info: await stat(filename, { bigint: true }),
				bytes: await readFile(filename),
			};
			assert.equal(
				persisted.info.dev,
				(await stat(process.cwd(), { bigint: true })).dev,
				'The atomic edit schedule requires keyfile and staged bytes on one filesystem',
			);
		});
		await probe('profile-version-id', async () => {
			assert(persisted, 'Missing persisted profile receipt');
			const { readNmVersionId } = await import(
				'../../../src/modules/network/network-manager-profile-write.ts'
			);
			assert.equal(typeof (await readNmVersionId(persisted.path)), 'bigint');
		});
		await probe('network-manager-restart', async () => {
			const args = [
				'--system',
				'call',
				'org.freedesktop.DBus',
				'/org/freedesktop/DBus',
				'org.freedesktop.DBus',
				'GetNameOwner',
				's',
				'org.freedesktop.NetworkManager',
			];
			const owner = await run('busctl', args);
			await run('systemctl', ['restart', 'NetworkManager']);
			assert.notEqual(await run('busctl', args), owner);
		});
		await probe('restart-file-continuity', async () => {
			assert(persisted, 'Missing persisted profile receipt');
			assert(
				(await readFile(persisted.filename)).equals(persisted.bytes),
				'Restart rewrote inactive keyfile',
			);
			const after = await stat(persisted.filename, { bigint: true });
			assert.deepEqual(
				[after.dev, after.ino, after.ctimeNs],
				[persisted.info.dev, persisted.info.ino, persisted.info.ctimeNs],
			);
		});
		await probe('offline-keyfile-stdin', async () => {
			assert(radio, 'Missing parent radio');
			const keyfile = await cli([
				'--offline',
				'con',
				'add',
				'type',
				'wifi',
				'ifname',
				radio,
				'con-name',
				'CeraPreflight',
				'ssid',
				'CeraPreflight',
				'wifi.mode',
				'ap',
				'wifi-sec.key-mgmt',
				'wpa-psk',
				'ipv4.method',
				'shared',
				'ipv6.method',
				'ignore',
			]);
			const modified = await runWithStdin(
				'nmcli',
				['--offline', 'con', 'modify', 'connection.autoconnect', 'no'],
				keyfile,
				{ timeout: 3000, maxBuffer: 65536 },
			);
			assert.match(modified, /^autoconnect=false$/m);
		});
	} finally {
		await probe('nm-profile-cleanup', async () => {
			if (created) await cli(['con', 'delete', 'uuid', uuid]);
		});
	}
}
