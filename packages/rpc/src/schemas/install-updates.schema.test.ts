/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { systemContract } from '../contracts/system.contract';

describe('manual install input boundary', () => {
	test.each([undefined, {}, { scope: 'packages' }])(
		'accepts backward-compatible input %j',
		async (input) => {
			// Given the actual contract boundary, when a supported input is parsed.
			const schema = systemContract.installUpdatesNow['~orpc'].inputSchemas?.[0];
			expect(schema).toBeDefined();
			const result = await schema?.['~standard'].validate(input);
			// Then the selector survives unchanged, including the absent legacy input.
			expect(result).toEqual({ value: input });
		},
	);

	test.each([{ scope: 'os' }, { scope: 'packages', extra: true }, { extra: true }, null])(
		'rejects unsupported input %j',
		async (input) => {
			// Given unsupported scope/fields, when the contract parses them.
			const result =
				await systemContract.installUpdatesNow['~orpc'].inputSchemas?.[0]?.['~standard'].validate(
					input,
				);
			// Then no broad install can be reached by silently stripping the selector.
			expect(result?.issues?.length).toBeGreaterThan(0);
		},
	);
});
