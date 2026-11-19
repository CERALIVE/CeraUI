/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { logsContract } from '../contracts/logs.contract';
import * as logs from './logs.schema';

describe('defaulted log output JSON schemas', () => {
	const defaults = [
		[
			'filter',
			logs.logFilterSchema,
			['sources', 'levels'],
			{ sources: [], levels: ['error', 'warning', 'info', 'debug'] },
		],
		[
			'query',
			logs.logQueryWithoutContinuationSchema,
			['sources', 'levels', 'boot', 'direction', 'limit'],
			{
				sources: [],
				levels: ['error', 'warning', 'info', 'debug'],
				boot: 'current',
				direction: 'older',
				limit: 100,
			},
		],
		['export', logs.logExportInputSchema, ['filter', 'boot'], { boot: 'current' }],
	] as const;
	for (const [name, schema, required, values] of defaults) {
		test.each(['draft-2020-12', 'openapi-3.0'] as const)(
			`${name} retains output requiredness and defaults for %s`,
			(target) => {
				const json = z.toJSONSchema(schema, { target, io: 'output' });
				expect(json.required).toEqual([...required]);
				for (const [key, value] of Object.entries(values)) {
					const property = json.properties?.[key];
					expect(typeof property === 'object' ? property.default : undefined).toEqual(value);
				}
			},
		);
	}
});

describe('log refinement issue contracts', () => {
	test.each([
		['bootId', logs.logAroundInputSchema, { bootId: '!', at: 0 }, '/^[0-9a-f]{32}$/'],
		['continuation', logs.logQueryInputSchema, { continuation: '!' }, '/^[A-Za-z0-9_-]+$/'],
		['afterCursor', logs.logFollowStartInputSchema, { afterCursor: '!' }, '/^[A-Za-z0-9=;:_.-]+$/'],
		[
			'eventId',
			logs.logAroundInputSchema,
			{ bootId: '0123456789abcdef0123456789abcdef', at: 0, eventId: '!' },
			'/^[A-Za-z0-9-]+$/',
		],
	] as const)('%s retains its exact regex issue', (field, schema, input, pattern) => {
		expect(
			schema.safeParse(input).error?.issues.map((issue) => ({
				path: issue.path,
				code: issue.code,
				format: issue.code === 'invalid_format' ? issue.format : undefined,
				pattern: issue.code === 'invalid_format' ? issue.pattern : undefined,
				message: issue.message,
			})),
		).toEqual([
			{
				path: [field],
				code: 'invalid_format',
				format: 'regex',
				pattern,
				message: `Invalid string: must match pattern ${pattern}`,
			},
		]);
	});

	test.each([
		[
			'query',
			logs.logQueryInputSchema,
			{ since: 1, until: 1 },
			['until'],
			'until must be greater than since',
		],
		[
			'export',
			logs.logExportInputSchema,
			{ filter: {}, since: 1, until: 0 },
			['until'],
			'until must be greater than since',
		],
		[
			'UTF-8 text',
			logs.logFilterSchema,
			{ text: 'a'.repeat(257) },
			['text'],
			'text must be at most 256 UTF-8 bytes',
		],
		['NUL text', logs.logFilterSchema, { text: 'a\0b' }, ['text'], 'text must not contain NUL'],
	] as const)('%s rejects with its exact custom issue', (_name, schema, input, path, message) => {
		expect(
			schema.safeParse(input).error?.issues.map((issue) => ({
				path: issue.path,
				code: issue.code,
				message: issue.message,
			})),
		).toEqual([{ path: [...path], code: 'custom', message }]);
	});
});

describe('log procedure input and output bindings', () => {
	const bindings = [
		['query', logs.logQueryInputSchema, logs.logQueryOutputSchema],
		['around', logs.logAroundInputSchema, logs.logAroundOutputSchema],
		['followStart', logs.logFollowStartInputSchema, logs.logFollowStartOutputSchema],
		['followStop', undefined, logs.logFollowStopOutputSchema],
		['getStorage', undefined, logs.logStorageSchema],
		['setRetention', logs.logRetentionSchema, logs.logStorageOutputSchema],
		['deleteOlderFiles', undefined, logs.logDeleteOlderFilesOutputSchema],
		['deleteLegacyDebug', undefined, logs.logStorageOutputSchema],
		['clearAll', undefined, logs.logDeleteOlderFilesOutputSchema],
		['createExport', logs.logExportInputSchema, logs.logExportOutputSchema],
		['previewBundle', undefined, logs.logBundleManifestSchema],
		['createBundle', undefined, logs.logExportOutputSchema],
	] as const;
	test.each(bindings)('%s binds the declared shared schemas', (name, input, output) => {
		expect(logsContract[name]['~orpc'].inputSchemas).toEqual(input ? [input] : undefined);
		expect(logsContract[name]['~orpc'].outputSchemas).toEqual([output]);
	});
	test('boots returns an array of shared boot information', () => {
		expect(logsContract.boots['~orpc'].inputSchemas).toBeUndefined();
		expect(logsContract.boots['~orpc'].outputSchemas).toHaveLength(1);
		const schema = logsContract.boots['~orpc'].outputSchemas?.[0];
		expect(schema).toBeInstanceOf(z.ZodArray);
		if (schema instanceof z.ZodArray) expect(schema.element).toBe(logs.logBootInfoSchema);
	});
});
