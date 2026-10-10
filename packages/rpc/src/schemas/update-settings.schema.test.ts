/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ZodError } from 'zod';
import { updateSettingsInputSchema, updateSettingsSchema } from './update-settings.schema.js';

describe('update settings wire contract', () => {
	test('defaults the complete canonical settings on an empty persisted object', () => {
		// Given an old image with no explicit update preferences.
		// When the persisted document is parsed.
		const settings = updateSettingsSchema.parse({});
		// Then every preference has the policy default, with no drill channel.
		expect(settings).toEqual({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: 'any-idle', start: '03:00', end: '05:00' },
			channel: 'stable',
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		});
	});

	test.each([
		{ schedule: { mode: 'window', start: '25:00', end: '05:00' } },
		{ schedule: { mode: 'window', start: '03:00', end: '05:99' } },
		{ channel: 'drill' },
		{ packagesAuto: 'yes' },
		{ unexpected: true },
	])('rejects invalid persisted settings: %j', (invalid) => {
		// Given an invalid field, when parsing, then a typed validation error is raised.
		expect(() => updateSettingsSchema.parse(invalid)).toThrow(ZodError);
	});

	test('rejects incomplete mutation input rather than silently defaulting a field', () => {
		// Given an incomplete RPC mutation, when parsed, then validation fails.
		expect(() => updateSettingsInputSchema.parse({ channel: 'beta' })).toThrow(ZodError);
	});
});
