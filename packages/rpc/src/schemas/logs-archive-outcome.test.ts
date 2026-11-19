import { describe, expect, test } from 'bun:test';
import { type LogDeleteOlderFilesOutput, logDeleteOlderFilesOutputSchema } from './logs.schema.ts';

const success = {
	ok: true,
	storage: {
		journalBytes: null,
		journalDirBytes: null,
		legacyDebugBytes: 0,
		ceiling: null,
		retention: { maxAgeDays: null, maxSizeMb: null, detail: 'debug' },
		oldestEntryTs: null,
		recentVolume: [],
		recentSample: 0,
		eventsBytes: 0,
		lastMaintenance: null,
		lastClearedAt: null,
	},
	bootsBefore: 3,
	bootsAfter: 2,
	unverifiedArchivesKept: true,
} satisfies LogDeleteOlderFilesOutput;

describe('delete older archive warning', () => {
	test('retains the warning on the successful wire outcome', () => {
		expect(logDeleteOlderFilesOutputSchema.parse(success)).toEqual(success);
	});

	test.each([2, 0, -1, 1.5, '2'])('rejects an internal archive count %j', (count) => {
		expect(
			logDeleteOlderFilesOutputSchema.safeParse({ ...success, unverifiedArchivesKeptCount: count })
				.success,
		).toBe(false);
	});
});
