import { describe, expect, test } from 'bun:test';

import {
	CAPABILITY_MODULE_CONFIG_KEY,
	CAPABILITY_MODULE_MUTATION_KIND,
	CAPABILITY_MODULES,
	capabilityModuleClaimsSchema,
	isCapabilityGateEnabled,
	isJournaledCapabilityModule,
	JOURNALED_CAPABILITY_MODULES,
	MUTATING_CAPABILITY_MODULES,
	mayClaimSupport,
	mayRenderModule,
	readCapabilityGates,
	resolveSupportClaim,
	SUPPORT_CLAIM_STATES,
	type SupportClaimState,
} from './capability-modules.schema';
import { capabilityMutationRefusalSchema, modemMutationKindSchema } from './modems.schema';

describe('the five-state support-claim taxonomy', () => {
	test('the ladder has exactly five states', () => {
		expect([...SUPPORT_CLAIM_STATES].sort()).toEqual([
			'capable',
			'certified',
			'enabled',
			'implemented',
			'unavailable',
		]);
	});

	test('a module this build does not ship is unavailable, whatever the gate says', () => {
		for (const gateEnabled of [false, true]) {
			expect(
				resolveSupportClaim({
					implemented: false,
					gateEnabled,
					capability: 'present',
					certified: true,
				}),
			).toBe('unavailable');
		}
	});

	test('gate OFF stops the ladder at implemented, even on a certified modem', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: false,
				capability: 'present',
				certified: true,
			}),
		).toBe('implemented');
	});

	test('gate ON with an UNKNOWN capability stops at enabled — an unasked question is not an answer', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: true,
				capability: 'unknown',
				certified: true,
			}),
		).toBe('enabled');
	});

	test('gate ON on a modem that positively LACKS the capability is unavailable', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: true,
				capability: 'absent',
				certified: false,
			}),
		).toBe('unavailable');
	});

	test('gate ON + capability present, no evidence bundle, is capable', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: true,
				capability: 'present',
				certified: false,
			}),
		).toBe('capable');
	});

	test('capable + a reviewed evidence bundle is certified', () => {
		expect(
			resolveSupportClaim({
				implemented: true,
				gateEnabled: true,
				capability: 'present',
				certified: true,
			}),
		).toBe('certified');
	});
});

describe('what each state permits', () => {
	test('only capable and certified may be surfaced', () => {
		const surfaceable = SUPPORT_CLAIM_STATES.filter((state) => mayRenderModule(state));
		expect([...surfaceable].sort()).toEqual(['capable', 'certified']);
	});

	test('only certified may be claimed by docs or the support matrix', () => {
		const claimable = SUPPORT_CLAIM_STATES.filter((state) => mayClaimSupport(state));
		expect(claimable).toEqual(['certified']);
	});

	test('every claimable state is also surfaceable — a doc cannot outrun the UI', () => {
		for (const state of SUPPORT_CLAIM_STATES) {
			if (mayClaimSupport(state)) expect(mayRenderModule(state)).toBe(true);
		}
	});
});

describe('the seven gated modules', () => {
	test('all seven are OFF by default — an absent gates object consents to nothing', () => {
		const gates = readCapabilityGates(undefined);
		for (const module of CAPABILITY_MODULES) {
			expect(gates[module]).toBe(false);
		}
	});

	test('an explicit false is as inert as an absent key', () => {
		expect(isCapabilityGateEnabled({ band_lock: false }, 'band-lock')).toBe(false);
		expect(isCapabilityGateEnabled({}, 'band-lock')).toBe(false);
	});

	test('each module reads its OWN config key and no other', () => {
		for (const module of CAPABILITY_MODULES) {
			const gates = { [CAPABILITY_MODULE_CONFIG_KEY[module]]: true };
			for (const other of CAPABILITY_MODULES) {
				expect(isCapabilityGateEnabled(gates, other)).toBe(other === module);
			}
		}
	});

	test('the config keys are distinct — a shared key would gate two modules at once', () => {
		const keys = CAPABILITY_MODULES.map((module) => CAPABILITY_MODULE_CONFIG_KEY[module]);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe('the mutation vocabulary these modules contribute', () => {
	test('SMS contributes no mutation kind — the surface is permanently read-only', () => {
		expect(MUTATING_CAPABILITY_MODULES).not.toContain('sms');
		expect(Object.keys(CAPABILITY_MODULE_MUTATION_KIND)).not.toContain('sms');
	});

	test('every mutating module maps to a kind the journal schema accepts', () => {
		for (const module of MUTATING_CAPABILITY_MODULES) {
			expect(
				modemMutationKindSchema.safeParse(CAPABILITY_MODULE_MUTATION_KIND[module]).success,
			).toBe(true);
		}
	});

	test('the journaled split is exactly the connectivity-losing modules', () => {
		expect([...JOURNALED_CAPABILITY_MODULES].sort()).toEqual([
			'band-lock',
			'esim',
			'fcc-auto-unlock',
			'five-g-pref',
		]);
		expect(isJournaledCapabilityModule('gps')).toBe(false);
		expect(isJournaledCapabilityModule('ussd')).toBe(false);
	});

	test('the gate refusals are reachable, and are NOT shared mutation-safety refusals', () => {
		expect(capabilityMutationRefusalSchema.safeParse('module_disabled').success).toBe(true);
		expect(capabilityMutationRefusalSchema.safeParse('module_unavailable').success).toBe(true);
		expect(capabilityMutationRefusalSchema.safeParse('streaming_active').success).toBe(true);
	});
});

describe('the wire claim matrix', () => {
	test('it is TOTAL — a payload omitting one module is rejected', () => {
		const complete = Object.fromEntries(
			CAPABILITY_MODULES.map((module) => [module, 'implemented' as SupportClaimState]),
		);
		expect(capabilityModuleClaimsSchema.safeParse(complete).success).toBe(true);

		const missingGps = Object.fromEntries(
			CAPABILITY_MODULES.filter((module) => module !== 'gps').map((module) => [
				module,
				'implemented' as SupportClaimState,
			]),
		);
		expect(capabilityModuleClaimsSchema.safeParse(missingGps).success).toBe(false);
	});

	test('an unknown state token is rejected rather than passed through', () => {
		const claims: Record<string, string> = {};
		for (const module of CAPABILITY_MODULES) claims[module] = 'implemented';
		claims['band-lock'] = 'probably';
		expect(capabilityModuleClaimsSchema.safeParse(claims).success).toBe(false);
	});
});
