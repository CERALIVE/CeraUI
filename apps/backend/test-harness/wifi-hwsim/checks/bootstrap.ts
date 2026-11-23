import { readFile, stat } from 'node:fs/promises';
import { run } from '../../../src/helpers/run.ts';
import { bootstrapAssociated, wifiRows } from './observations.ts';

async function main(): Promise<number> {
	if (process.getuid?.() !== 0 || process.env.HWSIM_REPO !== '/repo') {
		process.stderr.write('HWSIM-BOOTSTRAP: disposable root guest required\n');
		return 1;
	}
	let failures = 0;
	const check = (name: string, passed: boolean, detail = '') => {
		process.stdout.write(`HWSIM-BOOTSTRAP: ${name} passed=${Number(passed)} ${detail}\n`);
		if (!passed) failures++;
	};
	for (const path of ['setup.json', 'config.json', '/run/hwsim-client', '/run/hwsim-hostapd.pid']) {
		try {
			check(path, (await stat(path)).isFile());
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
			check(path, false, error.name);
		}
	}
	const read = async (path: string) => {
		try {
			return await readFile(path, 'utf8');
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
			check(`read:${path}`, false, error.name);
			return '';
		}
	};
	const client = (await read('/run/hwsim-client')).trim();
	check('client-name', client.length > 0);
	const pid = Number((await read('/run/hwsim-hostapd.pid')).trim());
	let alive = false;
	if (Number.isSafeInteger(pid) && pid > 1) {
		try {
			process.kill(pid, 0);
			alive = true;
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
		}
	}
	check('hostapd-pid', alive, `pid=${pid}`);
	check('hostapd-enabled', (await read('/run/hwsim-hostapd.log')).includes('AP-ENABLED'));
	try {
		const inventory = await run(
			'nmcli',
			['--colors', 'no', '-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'],
			{ timeout: 5000 },
		);
		const observed = wifiRows(inventory).find((row) => row.device === client);
		check(
			'client-associated',
			bootstrapAssociated(inventory, client),
			JSON.stringify(observed ?? {}),
		);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		check('client-observation', false, error.message);
	}
	return Number(failures !== 0);
}

if (import.meta.main) process.exitCode = await main();
