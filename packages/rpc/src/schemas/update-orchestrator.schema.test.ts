/// <reference types="bun" />
import { expect, test } from 'bun:test';
import {
	osStageRecoverySchema,
	updateOrchestratorPersistedStateSchema,
} from './update-orchestrator.schema';

test.each(['apt-exit-nonzero', 'commit_unit_absent_on_resume', 'commit_resume_inconclusive'])(
	'rejects an unsafe OS record when its reason is the non-OS failure %s',
	(reason) => {
		const record = {
			candidateKey: 'candidate',
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: 'unsafe' as const,
			reason,
		};
		expect(osStageRecoverySchema.safeParse(record).success).toBe(false);
	},
);

test.each(['rauc_recovery_unproven', 'os_stage_outcome_unknown_after_restart', 'rauc failed'])(
	'preserves terminal staging records when their reason is %s',
	(reason) => {
		const record = {
			candidateKey: 'candidate',
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: 'unsafe' as const,
			reason,
		};
		expect(osStageRecoverySchema.parse(record)).toEqual(record);
	},
);

const clock = {
	lastAttemptAt: null,
	lastSuccessAt: null,
	consecutiveFailures: 0,
	lastFailureWasRateLimited: false,
	nextAttemptAt: null,
};
const record = {
	candidateKey: 'k',
	activeAttemptId: null,
	failedRounds: 1,
	nextRetryAt: null,
	mode: 'unsafe',
	reason: 'rauc_recovery_unproven',
} as const;
const state = {
	schema: 1,
	phase: 'failed',
	enteredAt: 0,
	progress: null,
	failureReason: record.reason,
	packageCheck: clock,
	osCheck: clock,
	cellularOverrideId: null,
	osStageRecovery: record,
} as const;

test.each([
	{ ...state, phase: 'idle' },
	{ ...state, failureReason: 'other' },
	{ ...state, osStageRecovery: { ...record, activeAttemptId: 'a' } },
	{
		...state,
		phase: 'os-staging',
		osStageRecovery: { ...record, mode: 'automatic', activeAttemptId: 'a', nextRetryAt: 100 },
	},
	{
		...state,
		phase: 'os-available',
		osStageRecovery: { ...record, mode: 'operator', nextRetryAt: 100 },
	},
	{ ...state, osStageDiscoveryRetryAt: 100 },
])('H2-R2 rejects contradictory state-level OS recovery %#', (input) => {
	expect(updateOrchestratorPersistedStateSchema.safeParse(input).success).toBe(false);
});

test('preserves settled unsafe and pending-publication recovery without changing schema version', () => {
	expect(updateOrchestratorPersistedStateSchema.parse(state)).toEqual(state);
	const pending = {
		...state,
		phase: 'os-staged',
		osStageRecovery: { ...record, activeAttemptId: 'a', mode: 'automatic' },
	} as const;
	expect(updateOrchestratorPersistedStateSchema.parse(pending)).toEqual(pending);
});

test('preserves optional historical attempt identity when a failure is settled', () => {
	// Given a persistence-only recovery record with exact provenance.
	const input = {
		...state,
		osStageRecovery: { ...record, attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
	};
	// When it crosses the persisted-state boundary.
	const parsed = updateOrchestratorPersistedStateSchema.parse(input);
	// Then provenance survives and legacy records still gain no identity.
	expect(parsed).toEqual(input);
	expect(updateOrchestratorPersistedStateSchema.parse(state)).toEqual(state);
});

test('rejects contradictory historical identity when the active attempt differs', () => {
	// Given an active record claiming two different attempts.
	const input = {
		...state,
		phase: 'os-staging',
		osStageRecovery: {
			...record,
			mode: 'automatic',
			activeAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		},
	};
	// When parsed, then ambiguity is refused rather than stripping provenance.
	expect(updateOrchestratorPersistedStateSchema.safeParse(input).success).toBe(false);
});

test.each([
	'attempt-a',
	'',
	'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
	'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaag',
])('rejects malformed historical attempt provenance when present: %s', (attemptId) => {
	// Given otherwise valid settled unsafe metadata with malformed identity.
	const input = { ...state, osStageRecovery: { ...record, attemptId } };
	// When parsed at the persistence boundary.
	const parsed = updateOrchestratorPersistedStateSchema.safeParse(input);
	// Then it cannot be treated as identified recovery metadata.
	expect(parsed.success).toBe(false);
});
