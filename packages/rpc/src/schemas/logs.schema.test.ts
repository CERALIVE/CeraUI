/// <reference types="bun" />
import './logs.schema.alphabets.test';
import './logs.schema.contract.test';
import './logs.schema.vocabulary.test';
import { describe, expect, test } from 'bun:test';
import type { ZodType } from 'zod';
import { appContract, logsContract } from '../contracts';
import {
	LOG_ERROR_CODES,
	LOG_FOLLOW_EVENT,
	LOG_LEVELS,
	LOG_SOURCES,
	type LogBootInfo,
	type LogBundleManifest,
	type LogExportInput,
	type LogFollowStartInput,
	type LogQueryInput,
	type LogQueryPage,
	type LogRetention,
	type LogStorage,
	logAroundInputSchema,
	logAroundOutputSchema,
	logBootInfoSchema,
	logBootSchema,
	logBundleManifestSchema,
	logClearAllOutputSchema,
	logEntrySchema,
	logErrorSchema,
	logExportInputSchema,
	logExportOutputSchema,
	logFilterSchema,
	logFollowMessageSchema,
	logFollowStartInputSchema,
	logFollowStartOutputSchema,
	logFollowStopOutputSchema,
	logQueryInputSchema,
	logQueryOutputSchema,
	logQueryPageSchema,
	logQueryWithoutContinuationSchema,
	logRetentionSchema,
	logStorageOutputSchema,
	logStorageSchema,
	versionContextSchema,
} from './index';
import type {} from './logs.schema.type-test';

const bootId = '66d8d1808694489b8c3a3fb4795cab24';
const cursor = `s=abc;i=1;b=${bootId};m=1;t=2;x=3`;
const entry = {
	cursor,
	ts: 1000,
	bootId,
	level: 'warning',
	source: null,
	unit: 'systemd-journald.service',
	message: 'Suppressed 10 messages',
	truncated: false,
	marker: 'suppressed',
} as const;
const page = {
	ok: true,
	entries: [entry],
	hasMore: null,
	termination: 'budget',
	continuation: 'eyJhIjoxfQ',
	historyEpoch: 1,
	bootId,
} satisfies LogQueryPage;
const versions = {
	bootId,
	osImage: null,
	slot: null,
	board: null,
	boardModel: null,
	ceraui: '2026.11.3',
	engine: null,
	senderVersion: '1.2.3',
	kernel: null,
	bun: null,
};
const storage = {
	journalBytes: null,
	journalDirBytes: null,
	legacyDebugBytes: 0,
	ceiling: null,
	retention: { maxAgeDays: null, maxSizeMb: null, detail: 'debug' },
	oldestEntryTs: null,
	recentVolume: [{ source: null, entries: 0, bytes: 0 }],
	recentSample: 0,
	eventsBytes: 0,
	lastMaintenance: { at: 1000, ok: true, targetMet: false },
	lastClearedAt: null,
} satisfies LogStorage;

describe('complete legal wire states and required fields', () => {
	const filter = { sources: ['app'], levels: ['info'], text: 'x' };
	const query = {
		...filter,
		boot: 'current',
		since: 0,
		until: 1,
		direction: 'older',
		limit: 1,
	};
	const fullEntry = { ...entry, source: 'app' };
	const fullPage = {
		...page,
		entries: [fullEntry],
		hasMore: true,
		termination: 'lookahead',
		continuation: 'YQ',
	};
	const fullVersions = {
		...versions,
		osImage: 'image',
		slot: 'A',
		board: 'board',
		boardModel: 'model',
		engine: 'engine',
		senderVersion: 'sender-version',
		kernel: 'kernel',
		bun: '1.4.4',
	};
	const boot = {
		bootId,
		index: -1,
		firstTs: 0,
		lastTs: 1,
		current: false,
		shutdown: 'clean',
		evidence: ['shutdown_target'],
		logsAvailable: true,
		versions: fullVersions,
	};
	const retention = { maxAgeDays: 1, maxSizeMb: 16, detail: 'debug' };
	const fullStorage = {
		journalBytes: 1,
		journalDirBytes: 1,
		legacyDebugBytes: 0,
		ceiling: { maxSizeMb: 16, maxAgeDays: 1 },
		retention,
		oldestEntryTs: 0,
		recentVolume: [{ source: 'app', entries: 1, bytes: 1 }],
		recentSample: 1,
		eventsBytes: 0,
		lastMaintenance: { at: 0, ok: true, targetMet: false },
		lastClearedAt: 0,
	};
	const around = {
		ok: true,
		anchor: fullEntry,
		approximate: false,
		older: fullPage,
		newer: fullPage,
		olderQuery: query,
		newerQuery: { ...query, direction: 'newer' },
	};
	const bundle = {
		sections: [{ id: 'versions', entries: 0, redactions: 0 }],
		exportedBy: fullVersions,
		boots: [{ bootId, versions: fullVersions }],
	};
	const filterDefaults = { sources: [], levels: ['error', 'warning', 'info', 'debug'] };
	const queryDefaults = { ...filterDefaults, boot: 'current', direction: 'older', limit: 100 };
	interface Boundary {
		readonly name: string;
		readonly schema: ZodType;
		readonly value: Record<string, unknown>;
		readonly optional?: readonly string[];
		readonly defaults?: Readonly<Record<string, unknown>>;
		readonly nullable?: readonly string[];
		readonly booleans?: readonly string[];
		readonly path?: readonly (string | number)[];
		readonly wrap?: (value: Record<string, unknown>) => unknown;
	}
	// Fixtures and allowed omissions come from the wire contract, not schema introspection.
	const boundaries: readonly Boundary[] = [
		{ name: 'error', schema: logErrorSchema, value: { ok: false, error: 'BUSY' } },
		{
			name: 'filter',
			schema: logFilterSchema,
			value: filter,
			optional: ['text'],
			defaults: filterDefaults,
		},
		{
			name: 'query',
			schema: logQueryInputSchema,
			value: { ...query, continuation: 'YQ' },
			optional: ['text', 'since', 'until', 'continuation'],
			defaults: queryDefaults,
		},
		{
			name: 'around query',
			schema: logQueryWithoutContinuationSchema,
			value: query,
			optional: ['text', 'since', 'until'],
			defaults: queryDefaults,
		},
		{
			name: 'entry',
			schema: logEntrySchema,
			value: fullEntry,
			nullable: ['source', 'marker'],
			booleans: ['truncated'],
		},
		{
			name: 'page',
			schema: logQueryPageSchema,
			value: fullPage,
			nullable: ['hasMore', 'continuation', 'bootId'],
			booleans: ['hasMore'],
		},
		{
			name: 'follow input',
			schema: logFollowStartInputSchema,
			value: { ...filter, afterCursor: cursor },
			optional: ['text', 'afterCursor'],
			defaults: filterDefaults,
		},
		{
			name: 'follow start',
			schema: logFollowStartOutputSchema,
			value: { ok: true, subscriptionId: 'sub-1', checkpointCursor: cursor },
			nullable: ['checkpointCursor'],
		},
		{
			name: 'follow stop',
			schema: logFollowStopOutputSchema,
			value: { success: true, checkpointCursor: cursor },
			nullable: ['checkpointCursor'],
			booleans: ['success'],
		},
		{
			name: 'follow message',
			schema: logFollowMessageSchema,
			value: {
				subscriptionId: 'sub-1',
				entries: [fullEntry],
				checkpointCursor: cursor,
				dropped: 0,
				gap: 'suppressed',
				ended: 'cleared',
			},
			optional: ['gap', 'ended'],
			nullable: ['checkpointCursor'],
		},
		{
			name: 'versions',
			schema: versionContextSchema,
			value: fullVersions,
			nullable: [
				'osImage',
				'slot',
				'board',
				'boardModel',
				'engine',
				'senderVersion',
				'kernel',
				'bun',
			],
		},
		{
			name: 'boot',
			schema: logBootInfoSchema,
			value: boot,
			nullable: ['versions'],
			booleans: ['current', 'logsAvailable'],
		},
		{
			name: 'retention',
			schema: logRetentionSchema,
			value: retention,
			nullable: ['maxAgeDays', 'maxSizeMb'],
		},
		{
			name: 'storage',
			schema: logStorageSchema,
			value: fullStorage,
			nullable: [
				'journalBytes',
				'journalDirBytes',
				'ceiling',
				'oldestEntryTs',
				'lastMaintenance',
				'lastClearedAt',
			],
		},
		{
			name: 'ceiling',
			schema: logStorageSchema,
			value: fullStorage.ceiling,
			path: ['ceiling'],
			wrap: (value) => ({ ...fullStorage, ceiling: value }),
		},
		{
			name: 'source volume',
			schema: logStorageSchema,
			value: { source: 'app', entries: 1, bytes: 1 },
			path: ['recentVolume', 0],
			nullable: ['source'],
			wrap: (value) => ({ ...fullStorage, recentVolume: [value] }),
		},
		{
			name: 'maintenance',
			schema: logStorageSchema,
			value: fullStorage.lastMaintenance,
			path: ['lastMaintenance'],
			booleans: ['ok', 'targetMet'],
			wrap: (value) => ({ ...fullStorage, lastMaintenance: value }),
		},
		{
			name: 'storage reply',
			schema: logStorageOutputSchema,
			value: { ok: true, storage: fullStorage },
		},
		{
			name: 'delete reply',
			schema: logClearAllOutputSchema,
			value: { ok: true, storage: fullStorage, bootsBefore: 2, bootsAfter: 1 },
		},
		{
			name: 'export input',
			schema: logExportInputSchema,
			value: { filter, boot: 'current', since: 0, until: 1 },
			optional: ['since', 'until'],
			defaults: { boot: 'current' },
		},
		{
			name: 'export reply',
			schema: logExportOutputSchema,
			value: { ok: true, url: '/api/logs/export?ticket=abc', expiresAt: 60000 },
		},
		{
			name: 'around input',
			schema: logAroundInputSchema,
			value: { bootId, at: 0, eventId: 'event-1' },
			optional: ['eventId'],
		},
		{
			name: 'around reply',
			schema: logAroundOutputSchema,
			value: around,
			nullable: ['anchor'],
			booleans: ['approximate'],
		},
		{ name: 'bundle', schema: logBundleManifestSchema, value: bundle },
		{
			name: 'bundle section',
			schema: logBundleManifestSchema,
			value: { id: 'versions', entries: 0, redactions: 0 },
			path: ['sections', 0],
			wrap: (value) => ({ ...bundle, sections: [value] }),
		},
		{
			name: 'bundle journal section',
			schema: logBundleManifestSchema,
			value: { id: 'journal', entries: 1, redactions: 0, bootsCovered: 1, complete: false },
			path: ['sections', 0],
			booleans: ['complete'],
			wrap: (value) => ({ ...bundle, sections: [value] }),
		},
		{
			name: 'bundle boot',
			schema: logBundleManifestSchema,
			value: { bootId, versions: fullVersions },
			path: ['boots', 0],
			nullable: ['versions'],
			wrap: (value) => ({ ...bundle, boots: [value] }),
		},
	];
	for (const boundary of boundaries) {
		const wire = (value: Record<string, unknown>): unknown =>
			boundary.wrap ? boundary.wrap(value) : value;
		test(`${boundary.name} preserves every supplied field exactly`, () => {
			const value = wire(boundary.value);
			expect(boundary.schema.parse(value)).toEqual(value);
		});
		test.each(Object.keys(boundary.value))(
			`${boundary.name} omission of %s has the specified result`,
			(key) => {
				const omitted = { ...boundary.value };
				delete omitted[key];
				if (boundary.optional?.includes(key) || Object.hasOwn(boundary.defaults ?? {}, key)) {
					const expected = { ...omitted };
					if (Object.hasOwn(boundary.defaults ?? {}, key)) expected[key] = boundary.defaults?.[key];
					expect(boundary.schema.parse(wire(omitted))).toEqual(wire(expected));
				} else {
					const result = boundary.schema.safeParse(wire(omitted));
					expect(
						result.success ? result.data : result.error.issues.map((issue) => issue.path),
					).toEqual([[...(boundary.path ?? []), key]]);
				}
			},
		);
		test.each(boundary.nullable ?? [])(
			`${boundary.name} preserves null %s as an explicit unknown`,
			(key) => {
				const value = wire({ ...boundary.value, [key]: null });
				expect(boundary.schema.parse(value)).toEqual(value);
			},
		);
		for (const key of boundary.booleans ?? []) {
			test.each([true, false])(`${boundary.name}.${key} preserves boolean %s`, (value) => {
				const input = wire({ ...boundary.value, [key]: value });
				expect(boundary.schema.parse(input)).toEqual(input);
			});
		}
	}
	test.each(['current', 'all', bootId])('accepts the explicit boot selector %s', (value) => {
		expect(logBootSchema.parse(value)).toBe(value);
	});
	test.each([31, 32, 33])('enforces the boot length boundary at %i characters', (length) => {
		const value = 'a'.repeat(length);
		if (length === 32) {
			expect(logQueryInputSchema.parse({ boot: value }).boot).toBe(value);
		} else {
			const result = logQueryInputSchema.safeParse({ boot: value });
			expect(result.success ? result.data : result.error.issues.map((issue) => issue.path)).toEqual(
				[['boot']],
			);
		}
	});
	test.each(['olderQuery', 'newerQuery'] as const)(
		'%s rejects its own embedded stale continuation',
		(key) => {
			const result = logAroundOutputSchema.safeParse({
				...around,
				[key]: {
					...query,
					direction: key === 'olderQuery' ? 'older' : 'newer',
					continuation: 'stale',
				},
			});
			expect(
				result.success
					? result.data
					: result.error.issues.map((issue) => ({
							code: issue.code,
							path: issue.path,
							message: issue.message,
						})),
			).toEqual([
				{
					code: 'unrecognized_keys',
					path: [key],
					message: 'Unrecognized key: "continuation"',
				},
			]);
		},
	);
	test.each([
		logQueryOutputSchema,
		logFollowStartOutputSchema,
		logStorageOutputSchema,
		logClearAllOutputSchema,
		logExportOutputSchema,
		logAroundOutputSchema,
	])('preserves every classified failure branch', (schema) => {
		for (const error of LOG_ERROR_CODES) {
			expect(schema.parse({ ok: false, error })).toEqual({ ok: false, error });
		}
	});
	test.each(LOG_SOURCES)('accepts source enum member %s', (source) => {
		expect(logEntrySchema.parse({ ...fullEntry, source }).source).toBe(source);
	});
	test.each(LOG_LEVELS)('accepts level enum member %s', (level) => {
		expect(logEntrySchema.parse({ ...fullEntry, level }).level).toBe(level);
	});
	test.each(['older', 'newer'])('accepts direction enum member %s', (direction) => {
		expect(logQueryInputSchema.parse({ direction }).direction).toBe(direction);
	});
	test.each(['lookahead', 'end', 'budget'])('accepts termination enum member %s', (termination) => {
		expect(logQueryPageSchema.parse({ ...fullPage, termination }).termination).toBe(termination);
	});
	test.each(['catchup_exceeded', 'cursor_unavailable', 'suppressed'])(
		'accepts gap enum member %s',
		(gap) => {
			expect(
				logFollowMessageSchema.parse({
					subscriptionId: 'sub-1',
					entries: [],
					checkpointCursor: null,
					dropped: 0,
					gap,
				}).gap,
			).toBe(gap);
		},
	);
	test.each(['follower_exit', 'boot_changed', 'cleared'])(
		'accepts ended enum member %s',
		(ended) => {
			expect(
				logFollowMessageSchema.parse({
					subscriptionId: 'sub-1',
					entries: [],
					checkpointCursor: null,
					dropped: 0,
					ended,
				}).ended,
			).toBe(ended);
		},
	);
	test.each(['clean', 'unclean', 'unknown', 'current'])(
		'accepts shutdown enum member %s',
		(shutdown) => {
			expect(logBootInfoSchema.parse({ ...boot, shutdown }).shutdown).toBe(shutdown);
		},
	);
	test.each(['debug', 'info'])('accepts detail enum member %s', (detail) => {
		expect(logRetentionSchema.parse({ ...retention, detail }).detail).toBe(detail);
	});
	test.each(['versions', 'events', 'journal', 'settings'])(
		'accepts bundle section enum member %s',
		(id) => {
			const section =
				id === 'journal'
					? { id, entries: 0, redactions: 0, bootsCovered: 0, complete: true }
					: { id, entries: 0, redactions: 0 };
			expect(logBundleManifestSchema.parse({ ...bundle, sections: [section] }).sections).toEqual([
				section,
			]);
		},
	);
	test('rejects a trailing non-journal character in an event id at the eventId path', () => {
		const result = logAroundInputSchema.safeParse({ bootId, at: 0, eventId: 'event/' });
		expect(result.success ? result.data : result.error.issues.map((issue) => issue.path)).toEqual([
			['eventId'],
		]);
	});
});

describe('raw log input boundary', () => {
	test('omitted options select the current boot, newest page and every source and level', () => {
		const input: LogQueryInput = {};
		const followInput: LogFollowStartInput = {};
		const exportInput: LogExportInput = { filter: {} };
		expect(logQueryInputSchema.parse(input)).toEqual({
			boot: 'current',
			direction: 'older',
			limit: 100,
			levels: ['error', 'warning', 'info', 'debug'],
			sources: [],
		});
		expect(logFollowStartInputSchema.parse(followInput)).toEqual({
			sources: [],
			levels: ['error', 'warning', 'info', 'debug'],
		});
		expect(logExportInputSchema.parse(exportInput)).toEqual({
			filter: { sources: [], levels: ['error', 'warning', 'info', 'debug'] },
			boot: 'current',
		});
	});

	test.each([
		{ continuation: '--file=/etc/shadow' },
		{ continuation: '' },
		{ continuation: 'a'.repeat(2049) },
		{ levels: [] },
		{ levels: ['fatal'] },
		{ sources: ['other'] },
		{ text: '' },
		{ text: 'a'.repeat(257) },
		{ text: '\u00e9'.repeat(129) },
		{ text: 'before\0after' },
		{ boot: '66d8d180-8694-489b-8c3a-3fb4795cab24' },
		{ boot: bootId.toUpperCase() },
		{ boot: `${bootId}\n` },
		{ boot: 'a'.repeat(31) },
		{ since: -1 },
		{ since: 0.5 },
		{ until: -1 },
		{ since: 100, until: 100 },
		{ since: 101, until: 100 },
		{ direction: 'reverse' },
		{ limit: 0 },
		{ limit: 201 },
		{ limit: 1.5 },
		{ unknown: true },
	])('rejects malformed query %j', (input) => {
		expect(logQueryInputSchema.safeParse(input).success).toBe(false);
	});

	test('accepts UTF-8 byte and paging limits inclusively and literal search text', () => {
		const input = {
			boot: 'all',
			since: 0,
			until: 1,
			direction: 'newer',
			limit: 200,
			text: '\u00e9'.repeat(128),
			continuation: 'a'.repeat(2048),
			sources: ['app'],
			levels: ['debug'],
		} satisfies LogQueryInput;
		expect(logQueryInputSchema.parse(input)).toEqual(input);
		expect(logFilterSchema.parse({ text: '[error].*' }).text).toBe('[error].*');
		expect(logBootSchema.parse(bootId)).toBe(bootId);
	});

	test.each(['a b', '--file=/etc/shadow', '', 'a'.repeat(1025)])(
		'rejects unsafe or oversized follow cursor %j',
		(afterCursor) => {
			expect(logFollowStartInputSchema.safeParse({ afterCursor }).success).toBe(false);
		},
	);

	test('follow accepts journal punctuation but rejects unrecognized input keys', () => {
		expect(logFollowStartInputSchema.parse({ afterCursor: cursor }).afterCursor).toBe(cursor);
		expect(
			logFollowStartInputSchema.parse({ afterCursor: 'a'.repeat(1024) }).afterCursor,
		).toHaveLength(1024);
		expect(logFollowStartInputSchema.safeParse({ boot: 'all' }).success).toBe(false);
	});

	test('export enforces the same filter and ordered time range without paging options', () => {
		expect(logExportInputSchema.parse({ filter: {}, boot: bootId, since: 0, until: 1 }).boot).toBe(
			bootId,
		);
		for (const input of [
			{ filter: { unknown: true } },
			{ filter: {}, since: 2, until: 1 },
			{ filter: {}, limit: 200 },
		]) {
			expect(logExportInputSchema.safeParse(input).success).toBe(false);
		}
	});
});

describe('closed raw log object and value boundaries', () => {
	const boot = {
		bootId,
		index: -1,
		firstTs: 0,
		lastTs: 1000,
		current: false,
		shutdown: 'unknown',
		evidence: [],
		logsAvailable: true,
		versions: null,
	} satisfies LogBootInfo;
	const followStart = { ok: true, subscriptionId: 'sub-1', checkpointCursor: null };
	const followStop = { success: true, checkpointCursor: null };
	const followMessage = {
		subscriptionId: 'sub-1',
		entries: [],
		checkpointCursor: null,
		dropped: 0,
	};
	const storageWithCeiling = {
		...storage,
		ceiling: { maxSizeMb: 16, maxAgeDays: 1 },
	};
	const storageReply = { ok: true, storage: storageWithCeiling };
	const deleteReply = { ...storageReply, bootsBefore: 2, bootsAfter: 1 };
	const exportReply = { ok: true, url: '/api/logs/export?ticket=abc', expiresAt: 60000 };
	const around = {
		ok: true,
		anchor: null,
		approximate: true,
		older: page,
		newer: page,
		olderQuery: {},
		newerQuery: { direction: 'newer' },
	};
	const bundle = {
		sections: [{ id: 'journal', entries: 0, redactions: 0, bootsCovered: 0, complete: true }],
		exportedBy: versions,
		boots: [{ bootId, versions: null }],
	} satisfies LogBundleManifest;

	// Filter, query, follow input, versions, retention and export input already
	// have unknown-key rejection cases above; these cover the remaining roots.
	test.each([
		{ name: 'error', schema: logErrorSchema, value: { ok: false, error: 'BUSY' } },
		{ name: 'entry', schema: logEntrySchema, value: entry },
		{ name: 'query page', schema: logQueryPageSchema, value: page },
		{ name: 'follow start reply', schema: logFollowStartOutputSchema, value: followStart },
		{ name: 'follow stop reply', schema: logFollowStopOutputSchema, value: followStop },
		{ name: 'follow message', schema: logFollowMessageSchema, value: followMessage },
		{ name: 'boot information', schema: logBootInfoSchema, value: boot },
		{ name: 'storage', schema: logStorageSchema, value: storageWithCeiling },
		{ name: 'storage reply', schema: logStorageOutputSchema, value: storageReply },
		{ name: 'delete reply', schema: logClearAllOutputSchema, value: deleteReply },
		{ name: 'export reply', schema: logExportOutputSchema, value: exportReply },
		{ name: 'around input', schema: logAroundInputSchema, value: { bootId, at: 0 } },
		{ name: 'around reply', schema: logAroundOutputSchema, value: around },
		{ name: 'bundle manifest', schema: logBundleManifestSchema, value: bundle },
	])('$name rejects unknown keys on an otherwise valid object', ({ schema, value }) => {
		expect(schema.safeParse(value).success).toBe(true);
		expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
	});

	test.each([
		{
			name: 'storage ceiling',
			schema: logStorageSchema,
			value: storageWithCeiling,
			invalid: {
				...storageWithCeiling,
				ceiling: { ...storageWithCeiling.ceiling, unexpected: true },
			},
		},
		{
			name: 'storage source volume',
			schema: logStorageSchema,
			value: storage,
			invalid: {
				...storage,
				recentVolume: [{ source: null, entries: 0, bytes: 0, unexpected: true }],
			},
		},
		{
			name: 'storage maintenance',
			schema: logStorageSchema,
			value: storage,
			invalid: {
				...storage,
				lastMaintenance: { ...storage.lastMaintenance, unexpected: true },
			},
		},
		{
			name: 'bundle section',
			schema: logBundleManifestSchema,
			value: bundle,
			invalid: {
				...bundle,
				sections: [{ ...bundle.sections[0], unexpected: true }],
			},
		},
		{
			name: 'bundle boot',
			schema: logBundleManifestSchema,
			value: bundle,
			invalid: { ...bundle, boots: [{ bootId, versions: null, unexpected: true }] },
		},
	])('$name rejects nested unknown keys', ({ schema, value, invalid }) => {
		expect(schema.safeParse(value).success).toBe(true);
		expect(schema.safeParse(invalid).success).toBe(false);
	});

	test.each([
		{ name: 'error', schema: logErrorSchema, value: { ok: false, error: 'BUSY' } },
		{ name: 'query', schema: logQueryOutputSchema, value: page },
		{ name: 'follow start', schema: logFollowStartOutputSchema, value: followStart },
		{ name: 'storage', schema: logStorageOutputSchema, value: storageReply },
		{ name: 'delete', schema: logClearAllOutputSchema, value: deleteReply },
		{ name: 'export', schema: logExportOutputSchema, value: exportReply },
		{ name: 'around', schema: logAroundOutputSchema, value: around },
	])('$name rejects an unknown success discriminant', ({ schema, value }) => {
		expect(schema.safeParse(value).success).toBe(true);
		expect(schema.safeParse({ ...value, ok: 'invalid' }).success).toBe(false);
	});

	test.each([
		{
			name: 'entry marker',
			schema: logEntrySchema,
			value: entry,
			invalid: { ...entry, marker: 'invalid' },
		},
		{
			name: 'query termination',
			schema: logQueryOutputSchema,
			value: page,
			invalid: { ...page, termination: 'invalid' },
		},
		{
			name: 'follow gap',
			schema: logFollowMessageSchema,
			value: { ...followMessage, gap: 'suppressed' },
			invalid: { ...followMessage, gap: 'invalid' },
		},
		{
			name: 'follow end',
			schema: logFollowMessageSchema,
			value: { ...followMessage, ended: 'cleared' },
			invalid: { ...followMessage, ended: 'invalid' },
		},
		{
			name: 'boot shutdown',
			schema: logBootInfoSchema,
			value: boot,
			invalid: { ...boot, shutdown: 'invalid' },
		},
		{
			name: 'bundle section id',
			schema: logBundleManifestSchema,
			value: bundle,
			invalid: { ...bundle, sections: [{ id: 'invalid', entries: 0, redactions: 0 }] },
		},
	])('$name rejects values outside its closed vocabulary', ({ schema, value, invalid }) => {
		expect(schema.safeParse(value).success).toBe(true);
		expect(schema.safeParse(invalid).success).toBe(false);
	});

	test('boot indices require integers while retaining negative historical indices', () => {
		expect(logBootInfoSchema.safeParse(boot).success).toBe(true);
		expect(logBootInfoSchema.safeParse({ ...boot, index: -0.5 }).success).toBe(false);
	});

	test.each([
		{ maxAgeDays: 1.5, maxSizeMb: 16, detail: 'debug' },
		{ maxAgeDays: 1, maxSizeMb: 16.5, detail: 'debug' },
	])('retention rejects fractional limits %j', (value) => {
		expect(logRetentionSchema.safeParse(value).success).toBe(false);
	});

	test.each(['journalBytes', 'journalDirBytes', 'legacyDebugBytes', 'eventsBytes'] as const)(
		'storage rejects negative %s while allowing zero',
		(field) => {
			expect(logStorageSchema.safeParse({ ...storage, [field]: 0 }).success).toBe(true);
			expect(logStorageSchema.safeParse({ ...storage, [field]: -1 }).success).toBe(false);
		},
	);

	test('storage accepts null when the legacy debug file size is not reported', () => {
		expect(
			logStorageSchema.parse({ ...storage, legacyDebugBytes: null }).legacyDebugBytes,
		).toBeNull();
	});

	test.each([
		{ maxSizeMb: 0, maxAgeDays: 1 },
		{ maxSizeMb: 1, maxAgeDays: 0 },
		{ maxSizeMb: 1.5, maxAgeDays: 1 },
		{ maxSizeMb: 1, maxAgeDays: 1.5 },
	])('storage rejects nonpositive or fractional image ceilings %j', (ceiling) => {
		expect(logStorageSchema.safeParse({ ...storage, ceiling }).success).toBe(false);
	});

	test('accepts the specified lower and upper boundaries', () => {
		expect(logQueryInputSchema.parse({ limit: 1, text: 'x' }).limit).toBe(1);
		expect(logRetentionSchema.parse({ maxAgeDays: 1, maxSizeMb: 16, detail: 'debug' })).toEqual({
			maxAgeDays: 1,
			maxSizeMb: 16,
			detail: 'debug',
		});
		expect(
			logStorageSchema.safeParse({
				...storage,
				ceiling: { maxSizeMb: 1, maxAgeDays: 1 },
			}).success,
		).toBe(true);
		expect(
			logAroundInputSchema.parse({ bootId, at: 0, eventId: 'a'.repeat(64) }).eventId,
		).toHaveLength(64);
	});
});

describe('raw log responses preserve uncertainty and recoverable failures', () => {
	test('budget-limited and completed query pages both parse', () => {
		expect(logQueryOutputSchema.parse(page)).toEqual(page);
		expect(
			logQueryOutputSchema.parse({
				...page,
				entries: [],
				hasMore: false,
				termination: 'end',
				continuation: null,
				bootId: null,
			}),
		).toEqual({
			...page,
			entries: [],
			hasMore: false,
			termination: 'end',
			continuation: null,
			bootId: null,
		});
		expect(
			logQueryOutputSchema.parse({
				...page,
				hasMore: true,
				termination: 'lookahead',
			}),
		).toEqual({ ...page, hasMore: true, termination: 'lookahead' });
	});

	test.each([
		'CURSOR_UNAVAILABLE',
		'BOOT_UNAVAILABLE',
		'FILTER_CHANGED',
		'JOURNAL_UNAVAILABLE',
		'BUSY',
		'RECORD_TOO_LARGE',
		'READ_FAILED',
		'INVALID_RETENTION',
		'UPDATE_IN_PROGRESS',
	])('preserves the explicit %s failure instead of a success page', (error) => {
		expect(logQueryOutputSchema.parse({ ok: false, error })).toEqual({ ok: false, error });
	});

	test.each([
		{ ok: true, error: 'READ_FAILED' },
		{ ok: false, error: 'UNKNOWN' },
		{ ...page, ok: 'true' },
		{ ...page, historyEpoch: 1.5 },
		{ ...page, bootId: 'current' },
	])('rejects misleading or malformed query output %j', (output) => {
		expect(logQueryOutputSchema.safeParse(output).success).toBe(false);
	});

	test('entries retain suppression markers, unknown sources and full messages', () => {
		expect(logEntrySchema.parse(entry)).toEqual(entry);
		expect(
			logEntrySchema.parse({
				...entry,
				source: 'app',
				marker: null,
				message: 'x'.repeat(8192),
				truncated: true,
			}).message,
		).toHaveLength(8192);
		expect(logEntrySchema.safeParse({ ...entry, bootId: 'current' }).success).toBe(false);
	});

	test('follow checkpoints survive empty batches, pause and explicit gaps or termination', () => {
		expect(LOG_FOLLOW_EVENT).toBe('logs.follow');
		expect(
			logFollowStartOutputSchema.parse({
				ok: true,
				subscriptionId: 'sub-1',
				checkpointCursor: cursor,
			}),
		).toEqual({ ok: true, subscriptionId: 'sub-1', checkpointCursor: cursor });
		expect(logFollowStartOutputSchema.parse({ ok: false, error: 'BUSY' })).toEqual({
			ok: false,
			error: 'BUSY',
		});
		expect(
			logFollowStopOutputSchema.parse({
				success: true,
				checkpointCursor: null,
			}),
		).toEqual({ success: true, checkpointCursor: null });
		for (const gap of ['catchup_exceeded', 'cursor_unavailable', 'suppressed'] as const) {
			expect(
				logFollowMessageSchema.parse({
					subscriptionId: 'sub-1',
					entries: [],
					checkpointCursor: cursor,
					dropped: 3,
					gap,
				}).gap,
			).toBe(gap);
		}
		for (const ended of ['follower_exit', 'boot_changed', 'cleared'] as const) {
			expect(
				logFollowMessageSchema.parse({
					subscriptionId: 'sub-1',
					entries: [],
					checkpointCursor: null,
					dropped: 0,
					ended,
				}).ended,
			).toBe(ended);
		}
		expect(
			logFollowMessageSchema.safeParse({
				subscriptionId: 'sub-1',
				entries: [],
				checkpointCursor: null,
				dropped: -1,
			}).success,
		).toBe(false);
	});

	test('around returns resumable directions without an embedded continuation', () => {
		expect(logAroundInputSchema.parse({ bootId, at: 1000, eventId: 'event-1' })).toEqual({
			bootId,
			at: 1000,
			eventId: 'event-1',
		});
		const output = {
			ok: true,
			anchor: entry,
			approximate: false,
			older: page,
			newer: page,
			olderQuery: { direction: 'older' },
			newerQuery: { direction: 'newer' },
		};
		const parsed = logAroundOutputSchema.parse(output);
		expect(parsed.ok && parsed.olderQuery.direction).toBe('older');
		expect(
			logAroundOutputSchema.safeParse({
				...output,
				olderQuery: { continuation: 'stale' },
			}).success,
		).toBe(false);
		expect(logAroundInputSchema.safeParse({ bootId, at: 0, eventId: 'a'.repeat(65) }).success).toBe(
			false,
		);
		expect(logAroundInputSchema.safeParse({ bootId, at: 0, eventId: '../event' }).success).toBe(
			false,
		);
	});
});

describe('boot versions, storage and sharing', () => {
	test('versions retain senderVersion and unknown historical versions stay null', () => {
		expect(versionContextSchema.parse(versions)).toEqual(versions);
		expect(versionContextSchema.safeParse({ ...versions, sender: '1.2.3' }).success).toBe(false);
		const boot = {
			bootId,
			index: -1,
			firstTs: 0,
			lastTs: 1000,
			current: false,
			shutdown: 'unknown',
			evidence: ['too_few_entries'],
			logsAvailable: false,
			versions: null,
		} satisfies LogBootInfo;
		expect(logBootInfoSchema.parse(boot)).toEqual(boot);
		const manifest = {
			sections: [{ id: 'journal', entries: 0, redactions: 2, bootsCovered: 0, complete: false }],
			exportedBy: versions,
			boots: [{ bootId, versions: null }],
		} satisfies LogBundleManifest;
		expect(logBundleManifestSchema.parse(manifest)).toEqual(manifest);
	});

	test('retention defaults to the image ceiling without hard-coded upper bounds', () => {
		const retention = {
			maxAgeDays: null,
			maxSizeMb: null,
			detail: 'debug',
		} satisfies LogRetention;
		expect(logRetentionSchema.parse(retention)).toEqual(retention);
		expect(
			logRetentionSchema.parse({
				maxAgeDays: 1000,
				maxSizeMb: 1000000,
				detail: 'info',
			}),
		).toEqual({ maxAgeDays: 1000, maxSizeMb: 1000000, detail: 'info' });
		for (const input of [
			{ ...retention, maxAgeDays: 0 },
			{ ...retention, maxSizeMb: 15 },
			{ ...retention, detail: 'warning' },
			{ ...retention, unknown: true },
		]) {
			expect(logRetentionSchema.safeParse(input).success).toBe(false);
		}
	});

	test('storage distinguishes unknown usage and an unmet maintenance target from success', () => {
		expect(logStorageSchema.parse(storage)).toEqual(storage);
		expect(logStorageOutputSchema.parse({ ok: false, error: 'UPDATE_IN_PROGRESS' })).toEqual({
			ok: false,
			error: 'UPDATE_IN_PROGRESS',
		});
		expect(logStorageOutputSchema.parse({ ok: true, storage })).toEqual({ ok: true, storage });
		expect(
			logClearAllOutputSchema.parse({
				ok: true,
				storage,
				bootsBefore: 3,
				bootsAfter: 2,
			}),
		).toEqual({ ok: true, storage, bootsBefore: 3, bootsAfter: 2 });
	});

	test('export replies carry a download ticket or a classified failure', () => {
		expect(
			logExportOutputSchema.parse({
				ok: true,
				url: '/api/logs/export?ticket=abc',
				expiresAt: 60000,
			}),
		).toEqual({ ok: true, url: '/api/logs/export?ticket=abc', expiresAt: 60000 });
		expect(logExportOutputSchema.parse({ ok: false, error: 'BUSY' })).toEqual({
			ok: false,
			error: 'BUSY',
		});
	});

	test('the public barrels expose the closed log vocabulary and all twelve procedures', () => {
		expect(LOG_SOURCES).toEqual([
			'app',
			'engine',
			'bonding',
			'network',
			'cellular',
			'updates',
			'device',
			'kernel',
		]);
		expect(LOG_LEVELS).toEqual(['error', 'warning', 'info', 'debug']);
		expect(LOG_ERROR_CODES).toEqual([
			'CURSOR_UNAVAILABLE',
			'BOOT_UNAVAILABLE',
			'FILTER_CHANGED',
			'JOURNAL_UNAVAILABLE',
			'BUSY',
			'RECORD_TOO_LARGE',
			'READ_FAILED',
			'INVALID_RETENTION',
			'UPDATE_IN_PROGRESS',
		]);
		expect(Object.keys(appContract.logs).sort()).toEqual(Object.keys(logsContract).sort());
		expect(Object.keys(logsContract).sort()).toEqual([
			'around',
			'boots',
			'clearAll',
			'createBundle',
			'createExport',
			'deleteLegacyDebug',
			'followStart',
			'followStop',
			'getStorage',
			'previewBundle',
			'query',
			'setRetention',
		]);
	});
});
