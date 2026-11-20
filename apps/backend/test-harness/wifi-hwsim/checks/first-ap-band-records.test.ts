import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as exec from '../../../src/helpers/exec.ts';
import {
	resetRegdomainStateForTest,
	setRegdomainRunner,
} from '../../../src/modules/wifi/regdomain.ts';
import { wifiFrameFixture } from '../../../src/tests/helpers/wifi-frame-fixture.ts';
import { seedObservedRadioRow } from './first-ap-radio.ts';

const phy = readFileSync(
	new URL('../replay-corpus/commands/r22/iw-phy1-info.txt', import.meta.url),
	'utf8',
);
const bands = 'WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ';
for (const [stdout, capability] of [
	// Version-matched nmcli producer control, followed by protocol controls.
	['yes\nyes\n', ['auto', 'auto_24', 'auto_50']],
	['yes\nno\n', ['auto', 'auto_24']],
	['no\nyes\n', ['auto', 'auto_50']],
	['yes\n\n', null],
	['unknown\nunknown\n', null],
	['yes\n', null],
	['yes\nyes\nno\n', null],
] as const) {
	test(`native band observation on ${JSON.stringify(stdout)}`, async () => {
		const fixture = await wifiFrameFixture(false);
		try {
			resetRegdomainStateForTest();
			setRegdomainRunner(async (_bin, args) =>
				args[0] === 'phy'
					? phy
					: 'global\ncountry 00: DFS-UNSET\n (2402 - 2472 @ 40), (6, 20), (N/A)\n',
			);
			spyOn(exec, 'execFileP').mockImplementation(async (_bin, args = []) => {
				if (args.includes(bands)) return { stdout, stderr: '' };
				if (args.includes('GENERAL.STATE,GENERAL.CON-UUID'))
					return { stdout: '30 (disconnected)\n\n', stderr: '' };
				throw new Error('Unexpected NM query');
			});
			const row = seedObservedRadioRow({
				ifname: 'wlan0',
				owner: 'dc:a6:32:aa:bb:c0',
				uuid: 'test-ap',
				ssid: 'CeraTest',
				password: 'synthetic',
			});
			if (capability === null) {
				await expect(row).rejects.toThrow('Native radio bands are unreadable');
			} else {
				const { hotspot } = await row;
				expect(hotspot.bandCapability).toEqual([...capability]);
				expect(hotspot.availableChannels.includes('ch_6')).toBe(
					capability.some((band) => band === 'auto_24'),
				);
			}
		} finally {
			resetRegdomainStateForTest();
			await fixture.restore();
		}
	});
}
