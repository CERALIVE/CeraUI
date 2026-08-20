import { describe, expect, test } from 'bun:test';

import {
	CAPABILITY_MODULES,
	type CapabilityModule,
	type SupportClaimState,
} from '../schemas/capability-modules.schema';
import {
	claimableModules,
	IMPLEMENTED_CAPABILITY_MODULES,
	resolveCapabilityMatrix,
	surfaceableModules,
} from './capability-matrix';

const ALL: readonly CapabilityModule[] = CAPABILITY_MODULES;

function states(claims: Record<CapabilityModule, SupportClaimState>): SupportClaimState[] {
	return ALL.map((module) => claims[module]);
}

describe('the gate matrix', () => {
	test('OFF BY DEFAULT: no gates, no probe — every module reports implemented', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: {},
			capability: {},
		});
		expect(states(claims)).toEqual(ALL.map(() => 'implemented'));
		expect(surfaceableModules(claims)).toEqual([]);
		expect(claimableModules(claims)).toEqual([]);
	});

	test('turning ONE gate on moves only that module, and not past the probe', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: { gps: true },
			capability: {},
		});
		expect(claims.gps).toBe('enabled');
		for (const module of ALL) {
			if (module !== 'gps') expect(claims[module]).toBe('implemented');
		}
		expect(surfaceableModules(claims)).toEqual([]);
	});

	test('gate ON + a capable modem surfaces exactly that module', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: { 'band-lock': true, sms: true },
			capability: { 'band-lock': 'present' },
		});
		expect(claims['band-lock']).toBe('capable');
		expect(claims.sms).toBe('enabled');
		expect(surfaceableModules(claims)).toEqual(['band-lock']);
		expect(claimableModules(claims)).toEqual([]);
	});

	test('certification promotes the claim without changing what is surfaced', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: { 'band-lock': true },
			capability: { 'band-lock': 'present' },
			certified: { 'band-lock': true },
		});
		expect(claims['band-lock']).toBe('certified');
		expect(surfaceableModules(claims)).toEqual(['band-lock']);
		expect(claimableModules(claims)).toEqual(['band-lock']);
	});

	test('FAILURE FIXTURE: an INCAPABLE modem with the gate ON renders unavailable', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: Object.fromEntries(ALL.map((module) => [module, true])),
			capability: Object.fromEntries(ALL.map((module) => [module, 'absent' as const])),
		});
		expect(states(claims)).toEqual(ALL.map(() => 'unavailable'));
		expect(surfaceableModules(claims)).toEqual([]);
	});

	test('certification cannot rescue an incapable modem', () => {
		const claims = resolveCapabilityMatrix({
			implemented: ALL,
			gates: { esim: true },
			capability: { esim: 'absent' },
			certified: { esim: true },
		});
		expect(claims.esim).toBe('unavailable');
	});

	test('per-modem gating: one matrix per modem, from one set of gates', () => {
		const gates = { 'five-g-pref': true };
		const capable = resolveCapabilityMatrix({
			implemented: ALL,
			gates,
			capability: { 'five-g-pref': 'present' },
		});
		const incapable = resolveCapabilityMatrix({
			implemented: ALL,
			gates,
			capability: { 'five-g-pref': 'absent' },
		});
		expect(capable['five-g-pref']).toBe('capable');
		expect(incapable['five-g-pref']).toBe('unavailable');
	});

	test('the matrix is TOTAL — every module carries an explicit state', () => {
		const claims = resolveCapabilityMatrix({ implemented: ALL, gates: {}, capability: {} });
		for (const module of ALL) {
			expect(Object.hasOwn(claims, module)).toBe(true);
		}
	});
});

describe('the shipped registry', () => {
	// Asserted as a PROPERTY of whatever the registry holds, never as a fixed
	// membership list: each of the seven modules joins in its own change, so a
	// hardcoded set turns every one of those changes into an unrelated red test
	// while proving nothing the properties below do not.
	test('every listed module is a real module, and the list has no duplicates', () => {
		for (const module of IMPLEMENTED_CAPABILITY_MODULES) {
			expect(ALL).toContain(module);
		}
		expect(new Set(IMPLEMENTED_CAPABILITY_MODULES).size).toBe(
			IMPLEMENTED_CAPABILITY_MODULES.length,
		);
	});

	test('an UNLISTED module stays unavailable however capable and certified the device is', () => {
		const claims = resolveCapabilityMatrix({
			gates: Object.fromEntries(ALL.map((module) => [module, true])),
			capability: Object.fromEntries(ALL.map((module) => [module, 'present' as const])),
			certified: Object.fromEntries(ALL.map((module) => [module, true])),
		});
		for (const module of ALL) {
			if (IMPLEMENTED_CAPABILITY_MODULES.includes(module)) continue;
			expect(claims[module]).toBe('unavailable');
		}
	});

	test('being LISTED is rung one, not an offer — the operator gate still decides', () => {
		const claims = resolveCapabilityMatrix({
			gates: {},
			capability: Object.fromEntries(ALL.map((module) => [module, 'present' as const])),
		});
		for (const module of IMPLEMENTED_CAPABILITY_MODULES) {
			expect(claims[module]).toBe('implemented');
		}
	});
});
