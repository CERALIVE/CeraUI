/**
 * The shared SIM-less rule, pinned as a table.
 *
 * It lives in this package because the DEVICE's bond gate and the UI's toggle
 * must agree by construction — a live toggle over a link the device refuses, or
 * a disabled toggle over a link the device is bonding, are both lies. The table
 * below is what a second copy of the rule would have to reproduce exactly, and
 * is why there is no second copy.
 */
import { describe, expect, test } from 'bun:test';

import { isSimlessForBond, type SimBondEvidence } from './sim-bond-eligibility.ts';

describe('only a device-stated empty slot gates the bond', () => {
	const cases: Array<[string, SimBondEvidence, boolean]> = [
		['ModemManager reports an empty slot', { noSim: true }, true],
		["a dongle's own API reports an empty slot", { routerSim: 'absent' }, true],
		['ModemManager reports a card', { noSim: false }, false],
		['a dongle reports a card', { routerSim: 'present' }, false],
		["the dongle's slot could not be read", { routerSim: 'unknown' }, false],
		['nothing was reported at all', {}, false],
		['the fields are explicitly absent', { noSim: undefined }, false],
	];

	for (const [name, evidence, expected] of cases) {
		test(`${name} → ${expected}`, () => {
			expect(isSimlessForBond(evidence)).toBe(expected);
		});
	}

	// The two classes report the SAME condition through different fields, so
	// either alone must be sufficient — that asymmetry is the whole defect.
	test("either class's evidence alone is enough", () => {
		expect(isSimlessForBond({ noSim: true, routerSim: 'present' })).toBe(true);
		expect(isSimlessForBond({ noSim: false, routerSim: 'absent' })).toBe(true);
	});
});
