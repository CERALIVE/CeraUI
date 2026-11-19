/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { ZodType } from 'zod';
import {
	logAroundInputSchema,
	logFollowStartInputSchema,
	logQueryInputSchema,
} from './logs.schema';

const bootId = '66d8d1808694489b8c3a3fb4795cab24';
const defaults = { sources: [], levels: ['error', 'warning', 'info', 'debug'] };
const ascii = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
const languages: readonly {
	readonly name: string;
	readonly schema: ZodType;
	readonly field: string;
	readonly expected: Readonly<Record<string, unknown>>;
	readonly fixed: Readonly<Record<string, unknown>>;
	readonly alphabet: string;
	readonly min: number;
	readonly max: number;
	readonly bounded: boolean;
}[] = [
	{
		name: 'bootId',
		schema: logAroundInputSchema,
		field: 'bootId',
		fixed: { at: 0 },
		expected: { at: 0 },
		alphabet: '0123456789abcdef',
		min: 32,
		max: 32,
		bounded: false,
	},
	{
		name: 'continuation',
		schema: logQueryInputSchema,
		field: 'continuation',
		fixed: {},
		expected: { ...defaults, boot: 'current', direction: 'older', limit: 100 },
		alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
		min: 1,
		max: 2048,
		bounded: true,
	},
	{
		name: 'afterCursor',
		schema: logFollowStartInputSchema,
		field: 'afterCursor',
		fixed: {},
		expected: defaults,
		alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=;:_.-',
		min: 1,
		max: 1024,
		bounded: true,
	},
	{
		name: 'eventId',
		schema: logAroundInputSchema,
		field: 'eventId',
		fixed: { bootId, at: 0 },
		expected: { bootId, at: 0 },
		alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-',
		min: 1,
		max: 64,
		bounded: true,
	},
];

for (const language of languages) {
	describe(`${language.name} wire alphabet`, () => {
		test.each([...language.alphabet])(
			'accepts class member %j at the shortest length',
			(character) => {
				const value = character.repeat(language.min);
				expect(language.schema.parse({ ...language.fixed, [language.field]: value })).toEqual({
					...language.expected,
					[language.field]: value,
				});
			},
		);
		test.each([language.min, language.max])('accepts the inclusive length %i', (length) => {
			const value = 'a'.repeat(length);
			expect(language.schema.parse({ ...language.fixed, [language.field]: value })).toEqual({
				...language.expected,
				[language.field]: value,
			});
		});
		test.each([...new Set([0, language.min - 1, language.max + 1])])(
			'rejects the adjacent illegal length %i for the intended guard',
			(length) => {
				const result = language.schema.safeParse({
					...language.fixed,
					[language.field]: 'a'.repeat(length),
				});
				expect(result.error?.issues.map(({ path, code }) => ({ path, code }))).toEqual([
					{
						path: [language.field],
						code: language.bounded && length > language.max ? 'too_big' : 'invalid_format',
					},
				]);
			},
		);
		test.each([
			...ascii.filter((character) => !language.alphabet.includes(character)),
			'\u0660',
			'\uff10',
			'\u00e9',
			'\ud83d\ude00',
		])('rejects nonmember %j for the alphabet guard', (character) => {
			const result = language.schema.safeParse({
				...language.fixed,
				[language.field]: character.repeat(language.min),
			});
			expect(result.error?.issues.map(({ path, code }) => ({ path, code }))).toEqual([
				{ path: [language.field], code: 'invalid_format' },
			]);
		});
		test.each(['!', ' ', '\n', '\r', '\0', '\u0660'])(
			'anchors both ends against prefix and suffix %j',
			(junk) => {
				for (const value of [
					`${junk}${'a'.repeat(language.min)}`,
					`${'a'.repeat(language.min)}${junk}`,
				]) {
					const result = language.schema.safeParse({ ...language.fixed, [language.field]: value });
					expect(result.error?.issues.map(({ path, code }) => ({ path, code }))).toEqual([
						{ path: [language.field], code: 'invalid_format' },
					]);
				}
			},
		);
	});
}
