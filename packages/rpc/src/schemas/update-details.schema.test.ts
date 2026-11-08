/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	installUpdatesNowInputSchema,
	type UpdateTransportFinding,
	type UpdateTransportSummary,
	updateDetailsSchema,
	updateTransportFindingSchema,
} from './update-details.schema';

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

test('check waiting and failure observations are optional and survive the wire boundary', () => {
	const clock = {
		...details.checks.packages,
		deferred: { reason: 'metered_only' as const },
		consecutiveFailures: 2,
	};
	const parsed = updateDetailsSchema.parse({
		...details,
		os: { ...details.os, channelUnpublished: true },
		checks: { packages: clock, os: { ...clock, deferred: null } },
	});
	expect(parsed.checks.packages).toEqual(clock);
	expect(parsed.checks.os.deferred).toBeNull();
	expect(parsed.os.channelUnpublished).toBe(true);
	expect(updateDetailsSchema.parse(details)).toEqual(details);
	expect(
		updateDetailsSchema.safeParse({
			...details,
			checks: { ...details.checks, packages: { ...clock, deferred: { reason: 'offline' } } },
		}).success,
	).toBe(false);
});

describe('transport host evidence contract', () => {
	const finding = {
		ifname: 'wwan0',
		kind: 'cellular',
		family: 4,
		metered: true,
		healthy: false,
		captive: false,
		states: ['blocked'],
	} satisfies UpdateTransportFinding;
	const hosts: NonNullable<UpdateTransportFinding['hosts']> = [
		{ host: 'deb.debian.org', state: 'blocked' },
	];

	test('preserves package evidence independently of the latest OS selection', () => {
		const aptTransport = {
			profile: 'apt',
			checkedAt: 1,
			status: 'none',
			selected: null,
			findings: [{ ...finding, hosts }],
		} satisfies UpdateTransportSummary;
		expect(updateDetailsSchema.parse({ ...details, aptTransport }).aptTransport).toEqual(
			aptTransport,
		);
		expect(updateDetailsSchema.parse(details).aptTransport).toBeUndefined();
		expect(updateTransportFindingSchema.parse(finding).hosts).toBeUndefined();
	});

	test('accepts at most sixteen host verdicts using the existing state enum', () => {
		expect(updateTransportFindingSchema.parse({ ...finding, hosts }).hosts).toEqual(hosts);
		expect(
			updateTransportFindingSchema.safeParse({ ...finding, hosts: Array(16).fill(hosts[0]) })
				.success,
		).toBe(true);
		expect(
			updateTransportFindingSchema.safeParse({ ...finding, hosts: Array(17).fill(hosts[0]) })
				.success,
		).toBe(false);
		expect(
			updateTransportFindingSchema.safeParse({
				...finding,
				hosts: [{ host: 'deb.debian.org', state: 'timeout' }],
			}).success,
		).toBe(false);
	});
});

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
