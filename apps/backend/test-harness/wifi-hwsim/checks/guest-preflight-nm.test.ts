import { expect, spyOn, test } from 'bun:test';
import * as runner from '../../../src/helpers/run.ts';
import { probeNetworkManager } from './guest-preflight-nm.ts';

test('preflight removes its AP after failed activation and preserves unrelated profiles', async () => {
	const profiles = new Map([['unrelated', 'saved']]);
	const failures: string[] = [];
	let created = 0;
	const cli = spyOn(runner, 'run').mockImplementation(async (binary, args) => {
		if (binary === 'nmcli' && args.slice(0, 4).join(' ') === 'con add type wifi') {
			const uuid = args[args.indexOf('connection.uuid') + 1];
			if (!uuid) throw new Error('Missing fixture UUID');
			profiles.set(uuid, 'preflight');
			created++;
			return '';
		}
		if (binary === 'nmcli' && args.includes('up')) throw new Error('controlled activation refusal');
		if (binary === 'nmcli' && args.slice(0, 3).join(' ') === 'con delete uuid') {
			const uuid = args[3];
			if (!uuid || !profiles.delete(uuid)) throw new Error('Deleted an unowned profile');
			return '';
		}
		throw new Error('Remaining guest prerequisites unavailable in this offline test');
	});
	try {
		await probeNetworkManager(async (name, check) => {
			try {
				await check();
			} catch (error: unknown) {
				if (!(error instanceof Error)) throw error;
				failures.push(`${name}: ${error.message}`);
			}
		}, 'wlan2');

		expect(created).toBe(1);
		expect(failures).toContain('shared-ap-runtime: controlled activation refusal');
		expect([...profiles]).toEqual([['unrelated', 'saved']]);
	} finally {
		cli.mockRestore();
	}
});
