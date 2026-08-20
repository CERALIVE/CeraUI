/**
 * A modem save reconnects only when it has to.
 *
 * Operator report: toggling roaming permission or automatic APN forced the modem
 * through a fresh search/reconnect cycle. Measured on a Rock 5B+ (2026-08-17):
 * `applyModemConfig` ran `nmcli conn down` on EVERY save — the board's own
 * journal recorded `nmDisconnect err: … is not an active connection` for saves
 * against a modem that held no bearer at all. NetworkManager 1.42.4 on that
 * board refuses to reapply anything outside its property allowlist
 * (`Can't reapply changes to '802-3-ethernet.mac-address' setting`) and answers
 * `Device is not activated` for `nmcli device reapply cdc-wdm0`, so no gsm value
 * can reach a live bearer — which makes "reconnect only for a REAL change on a
 * bearer NM actually holds" the strongest honest rule available.
 */

import { describe, expect, test } from 'bun:test';

import {
	decideModemReactivation,
	diffModemConnectionFields,
	MODEM_CONNECTION_FIELD_KEYS,
	type ModemConnectionDraft,
	normalizeModemConnectionFields,
} from './modem-apply-scope';

const SAVED: ModemConnectionDraft = {
	autoconfig: false,
	apn: 'internet',
	username: '',
	password: '',
	roaming: true,
	network: '',
};

function fields(draft: ModemConnectionDraft, supported = true) {
	return normalizeModemConnectionFields(draft, supported);
}

function decide(
	next: ModemConnectionDraft,
	hold: 'held' | 'idle' | 'unknown',
	previous: ModemConnectionDraft = SAVED,
	supported = true,
) {
	return decideModemReactivation({
		previous: fields(previous, supported),
		next: fields(next, supported),
		hold,
	});
}

describe('normalization mirrors what NetworkManager is actually handed', () => {
	test('automatic APN clears the APN credentials, so a stale draft is not a change', () => {
		// The dialog keeps the operator's last manual APN in a disabled field.
		// Comparing raw values would read that as an edit and reconnect for it.
		const before = fields({ ...SAVED, autoconfig: true, apn: 'internet' });
		const after = fields({ ...SAVED, autoconfig: true, apn: 'leftover.apn' });

		expect(before.apn).toBe('');
		expect(diffModemConnectionFields(before, after)).toEqual([]);
	});

	test('a device that cannot honour automatic APN normalizes it away', () => {
		// `resolveGsmAutoconfigSupport()` false means the write forces
		// `gsm.auto-config: no` either way, so flipping the switch changes nothing
		// NetworkManager will see.
		const off = fields({ ...SAVED, autoconfig: false }, false);
		const on = fields({ ...SAVED, autoconfig: true }, false);

		expect(on.autoconfig).toBe(false);
		expect(diffModemConnectionFields(off, on)).toEqual([]);
	});

	test('the manual operator lock only exists while roaming is permitted', () => {
		// `gsm.network-id` is written as "" whenever roaming is off, so editing the
		// operator behind a disabled roaming switch is not a connect-time change.
		const a = fields({ ...SAVED, roaming: false, network: '73210' });
		const b = fields({ ...SAVED, roaming: false, network: '' });

		expect(a.network).toBe('');
		expect(diffModemConnectionFields(a, b)).toEqual([]);
	});

	test('an absent draft field is the empty value, never undefined', () => {
		expect(fields({})).toEqual({
			autoconfig: false,
			apn: '',
			username: '',
			password: '',
			roaming: false,
			network: '',
		});
	});
});

describe('the diff covers every connect-time field and nothing else', () => {
	test('every key is reachable, and turning automatic APN on carries the APN with it', () => {
		const cases: ReadonlyArray<[ModemConnectionDraft, ReadonlyArray<string>]> = [
			// Not ['autoconfig'] alone: switching to automatic clears `gsm.apn`, so
			// the write really does change two connect-time values.
			[{ ...SAVED, autoconfig: true }, ['autoconfig', 'apn']],
			[{ ...SAVED, apn: 'other.apn' }, ['apn']],
			[{ ...SAVED, username: 'user' }, ['username']],
			[{ ...SAVED, password: 'secret' }, ['password']],
			[{ ...SAVED, roaming: false }, ['roaming']],
			[{ ...SAVED, network: '73210' }, ['network']],
		];

		const reached = new Set(cases.flatMap(([, keys]) => keys));
		expect([...reached].sort()).toEqual([...MODEM_CONNECTION_FIELD_KEYS].sort());
		for (const [draft, expected] of cases) {
			expect(diffModemConnectionFields(fields(SAVED), fields(draft))).toEqual(expected);
		}
	});

	test('the network type is NOT a connect-time field', () => {
		// It is applied through mmcli's own `--set-allowed-modes`, which has always
		// been guarded separately; folding it in here would reconnect twice.
		expect(MODEM_CONNECTION_FIELD_KEYS).not.toContain(
			'network_type' as unknown as (typeof MODEM_CONNECTION_FIELD_KEYS)[number],
		);
	});
});

describe('the reactivation decision', () => {
	test('an untouched save never reconnects, even on a live bearer', () => {
		expect(decide(SAVED, 'held')).toEqual({ reactivate: false, reason: 'unchanged' });
	});

	test('toggling roaming out and back is an untouched save', () => {
		// The operator report, verbatim: flipping the switch twice used to cost a
		// full bearer teardown.
		const roundTrip = { ...SAVED, roaming: false };
		expect(decide({ ...roundTrip, roaming: true }, 'held')).toEqual({
			reactivate: false,
			reason: 'unchanged',
		});
	});

	test('a real change on a bearer NetworkManager holds DOES reconnect', () => {
		expect(decide({ ...SAVED, roaming: false }, 'held')).toEqual({
			reactivate: true,
			reason: 'connect-time-change',
			changed: ['roaming'],
		});
	});

	test('a real change on an idle profile reconnects nothing', () => {
		// The board's own state: the Quectel sits in `searching`, so its profile is
		// unattached and the old `nmcli conn down` could only ever error.
		expect(decide({ ...SAVED, autoconfig: true }, 'idle')).toEqual({
			reactivate: false,
			reason: 'not-held',
		});
	});

	test('an unreadable hold is treated as held, not as idle', () => {
		// Skipping on a failed read would leave the operator's setting unapplied
		// with nothing on screen saying so — worse than an interruption they were
		// warned about.
		expect(decide({ ...SAVED, apn: 'other.apn' }, 'unknown')).toEqual({
			reactivate: true,
			reason: 'connect-time-change',
			changed: ['apn'],
		});
	});

	test('several changed fields are all named, in field order', () => {
		const decision = decide({ ...SAVED, autoconfig: true, roaming: false }, 'held');
		expect(decision).toEqual({
			reactivate: true,
			reason: 'connect-time-change',
			changed: ['autoconfig', 'apn', 'roaming'],
		});
	});

	test('an unchanged save outranks the hold state in both directions', () => {
		for (const hold of ['held', 'idle', 'unknown'] as const) {
			expect(decide(SAVED, hold).reactivate).toBe(false);
		}
	});
});
