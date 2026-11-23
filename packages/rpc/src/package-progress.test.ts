import { expect, test } from 'bun:test';
import { holdUpdateProgress } from './package-progress';

const preparing = { total: 1, downloading: 0, unpacking: 0, setting_up: 0 };
const downloading = { total: 1, downloading: 1, unpacking: 0, setting_up: 0 };
const installing = { total: 1, downloading: 0, unpacking: 0, setting_up: 1 };

test('a running transaction never moves back a phase or a number', () => {
	const at40 = { ...installing, percent: 40 };
	expect(holdUpdateProgress(at40, { ...downloading, percent: 96 })).toBe(at40);
	expect(holdUpdateProgress(at40, preparing)).toBe(at40);
	expect(holdUpdateProgress(at40, { ...installing, percent: 35 })).toBe(at40);
	expect(holdUpdateProgress(at40, { ...installing, percent: 40 })).toBe(at40);
});

test('the same phase without a number replaces a held number: it is unknown now, not still 40', () => {
	const at40 = { ...installing, percent: 40 };
	const unknown = { ...installing };
	expect(holdUpdateProgress(at40, unknown)).toBe(unknown);
	const at45 = { ...installing, percent: 45 };
	expect(holdUpdateProgress(unknown, at45)).toBe(at45);
});

test('a running transaction moves forward a phase or a number', () => {
	const next = { ...installing, percent: 60 };
	expect(holdUpdateProgress({ ...installing, percent: 40 }, next)).toBe(next);
	expect(holdUpdateProgress({ ...downloading, percent: 96 }, installing)).toBe(installing);
	expect(holdUpdateProgress(preparing, downloading)).toBe(downloading);
	expect(holdUpdateProgress(undefined, preparing)).toBe(preparing);
});

test('an outcome, and the run after it, show what arrived', () => {
	const failed = { ...downloading, result: 'E: dpkg returned an error code (1)' };
	expect(holdUpdateProgress({ ...installing, percent: 80 }, failed)).toBe(failed);
	expect(holdUpdateProgress(failed, preparing)).toBe(preparing);
	const done = { ...installing, result: 0 };
	expect(holdUpdateProgress(done, preparing)).toBe(preparing);
});
