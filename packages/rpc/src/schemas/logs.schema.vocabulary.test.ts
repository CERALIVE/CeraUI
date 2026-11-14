/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import * as logs from './logs.schema';

describe('closed log schema vocabularies', () => {
	const vocabularies = [
		[
			'source',
			logs.logSourceSchema,
			['app', 'engine', 'bonding', 'network', 'cellular', 'updates', 'device', 'kernel'],
		],
		['level', logs.logLevelSchema, ['error', 'warning', 'info', 'debug']],
		[
			'error',
			logs.logErrorCodeSchema,
			[
				'CURSOR_UNAVAILABLE',
				'BOOT_UNAVAILABLE',
				'FILTER_CHANGED',
				'JOURNAL_UNAVAILABLE',
				'BUSY',
				'RECORD_TOO_LARGE',
				'READ_FAILED',
				'INVALID_RETENTION',
				'UPDATE_IN_PROGRESS',
			],
		],
		[
			'direction',
			logs.logQueryWithoutContinuationSchema.shape.direction.unwrap(),
			['older', 'newer'],
		],
		['termination', logs.logQueryPageSchema.shape.termination, ['lookahead', 'end', 'budget']],
		[
			'gap',
			logs.logFollowMessageSchema.shape.gap.unwrap(),
			['catchup_exceeded', 'cursor_unavailable', 'suppressed'],
		],
		[
			'ended',
			logs.logFollowMessageSchema.shape.ended.unwrap(),
			['follower_exit', 'boot_changed', 'cleared'],
		],
		['shutdown', logs.logBootInfoSchema.shape.shutdown, ['clean', 'unclean', 'unknown', 'current']],
		['detail', logs.logRetentionSchema.shape.detail, ['debug', 'info']],
		[
			'section',
			logs.logBundleManifestSchema.shape.sections.element.shape.id,
			['versions', 'events', 'journal', 'settings'],
		],
	] as const;
	for (const [name, schema, options] of vocabularies) {
		test(`${name} has exactly the specified options`, () => {
			const actual: readonly string[] = schema.options;
			expect(actual).toEqual(options);
		});
		test.each(options)(`${name} accepts specified member %s`, (value) => {
			expect(schema.parse(value)).toBe(value);
		});
		test(`${name} rejects a nonmember with invalid_value`, () => {
			expect(
				schema.safeParse('invalid').error?.issues.map(({ path, code }) => ({ path, code })),
			).toEqual([{ path: [], code: 'invalid_value' }]);
		});
	}
	test('boot selector literal branches are exactly current and all', () => {
		expect(
			z
				.toJSONSchema(logs.logBootSchema)
				.anyOf?.map((branch) => (typeof branch === 'boolean' ? branch : branch.const)),
		).toEqual(['current', 'all', undefined]);
		expect(
			logs.logBootSchema
				.safeParse('invalid')
				.error?.issues.map(({ path, code }) => ({ path, code })),
		).toEqual([{ path: [], code: 'invalid_format' }]);
	});
	test('suppression marker has exactly one non-null literal', () => {
		expect(logs.logEntrySchema.shape.marker.unwrap().value).toBe('suppressed');
		expect(logs.logEntrySchema.shape.marker.parse('suppressed')).toBe('suppressed');
		expect(
			logs.logEntrySchema.shape.marker
				.safeParse('invalid')
				.error?.issues.map(({ path, code }) => ({ path, code })),
		).toEqual([{ path: [], code: 'invalid_value' }]);
	});
	const tags = [
		['error', logs.logErrorSchema.shape.ok, false],
		['query', logs.logQueryPageSchema.shape.ok, true],
		['follow', logs.logFollowStartOutputSchema.options[0].shape.ok, true],
		['storage', logs.logStorageOutputSchema.options[0].shape.ok, true],
		['delete', logs.logDeleteOlderFilesOutputSchema.options[0].shape.ok, true],
		['export', logs.logExportOutputSchema.options[0].shape.ok, true],
		['around', logs.logAroundOutputSchema.options[0].shape.ok, true],
	] as const;
	for (const [name, schema, value] of tags) {
		test(`${name} has the exact success literal`, () => {
			expect(schema.value).toBe(value);
			expect(schema.parse(value)).toBe(value);
			expect(
				schema.safeParse('invalid').error?.issues.map(({ path, code }) => ({ path, code })),
			).toEqual([{ path: [], code: 'invalid_value' }]);
		});
	}
});
