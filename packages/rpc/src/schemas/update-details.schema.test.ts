/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { installUpdatesNowInputSchema, updateDetailsSchema } from './update-details.schema';

const details = {
	slots: null,
	os: { bootedVersion: null, staged: null, candidate: null },
	checks: {
		packages: { lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null },
		os: { lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null },
	},
	pendingCellular: null,
	transport: null,
} as const;

describe('update credential details contract', () => {
	test('accepts the kernel scope without changing legacy request or details shapes', () => {
		expect(installUpdatesNowInputSchema.parse({ scope: 'kernel' })).toEqual({ scope: 'kernel' });
		expect(installUpdatesNowInputSchema.parse(undefined)).toBeUndefined();
		expect(updateDetailsSchema.parse(details).kernel).toBeUndefined();
		expect(installUpdatesNowInputSchema.safeParse({ scope: 'all-kernels' }).success).toBe(false);
	});
	test('accepts absent credentials when reading an older backend', () => {
		// Given an old backend payload; When parsed; Then no observation is invented.
		expect(updateDetailsSchema.parse(details).credentials).toBeUndefined();
	});

	test.each(['valid', 'expiring', 'expired'] as const)(
		'preserves the public expiry when state is %s',
		(state) => {
			// Given a known public timestamp.
			const credentials = { expiresAt: 1_850_000_000_000, state };
			// When the shared wire boundary parses it.
			const parsed = updateDetailsSchema.parse({ ...details, credentials });
			// Then consumers receive the same timestamp and state.
			expect(parsed.credentials).toEqual(credentials);
		},
	);

	test('preserves unknown when expiry cannot be established', () => {
		// Given an unavailable observation; When parsed; Then it stays unknown.
		const credentials = { expiresAt: null, state: 'unavailable' } as const;
		expect(updateDetailsSchema.parse({ ...details, credentials }).credentials).toEqual(credentials);
	});

	test.each([
		{ expiresAt: Number.NaN, state: 'valid' },
		{ expiresAt: Number.POSITIVE_INFINITY, state: 'expired' },
		{ expiresAt: 12, state: 'healthy' },
		{ expiresAt: '2028-01-01', state: 'valid' },
	])('rejects invalid observation %j', (credentials) => {
		// Given invalid boundary input; When parsed; Then it is refused.
		expect(updateDetailsSchema.safeParse({ ...details, credentials }).success).toBe(false);
	});
});
