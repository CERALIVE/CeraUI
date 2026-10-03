/**
 * Update orchestrator Zod schemas (Todo 36).
 *
 * `updateOrchestratorPersistedStateSchema` is the on-disk shape validated by
 * the backend's `update-orchestrator/persistence.ts` before it is trusted as
 * the resumed in-memory state — `/data/ceralive/update-state/agent.json`.
 *
 * `updateOrchestratorWireStateSchema` is a SMALLER, ADDITIVE projection of that
 * same state exposed on the `status` frame as a NEW sibling field
 * (`update_orchestrator`), alongside the existing `update_state` field this
 * task does not touch. Every existing field on `statusMessageSchema` /
 * `statusResponseSchema` keeps its exact shape; this is a pure addition.
 */
import { z } from 'zod';

export const ORCHESTRATOR_PHASES = [
	'idle',
	'checking',
	'available',
	'downloading',
	'awaiting-idle',
	'committing',
	'restarting-services',
	'settled',
	'os-available',
	'os-staging',
	'os-staged',
	'os-activation-armed',
	'os-verifying',
	'sync-eligible',
	'syncing',
	'synced',
	'quarantined',
	'failed',
] as const;
export const updateOrchestratorPhaseSchema = z.enum(ORCHESTRATOR_PHASES);
export type UpdateOrchestratorPhase = z.infer<typeof updateOrchestratorPhaseSchema>;

export const updateOrchestratorProgressSchema = z.object({
	percent: z.number().min(0).max(100),
	etaSeconds: z.number().min(0),
});
export type UpdateOrchestratorProgress = z.infer<typeof updateOrchestratorProgressSchema>;

export const updateOrchestratorScheduleClockSchema = z.object({
	lastAttemptAt: z.number().nullable(),
	lastSuccessAt: z.number().nullable(),
	consecutiveFailures: z.number().int().min(0),
	lastFailureWasRateLimited: z.boolean(),
	nextAttemptAt: z.number().nullable(),
});
export type UpdateOrchestratorScheduleClock = z.infer<typeof updateOrchestratorScheduleClockSchema>;

export const OS_STAGE_RECOVERY_MODES = ['automatic', 'operator', 'unsafe'] as const;
export const OS_STAGE_CONFIRMABLE_UNSAFE_REASONS = [
	'rauc_recovery_unproven',
	'os_stage_outcome_unknown_after_restart',
] as const;

// Recovery policy for ONE exact OS candidate after a staging attempt. It rides
// through package phases untouched, so an OS stage waiting for its retry never
// stops package updates. An attempt counts as a failed round once, when it
// settles; `activeAttemptId` is persisted before the attempt has any effect.
export const osStageRecoverySchema = z
	.object({
		candidateKey: z.string().min(1),
		activeAttemptId: z.string().min(1).nullable(),
		// Persistence-only provenance retained after activeAttemptId is cleared.
		attemptId: z.uuid().optional(),
		failedRounds: z.number().int().min(0),
		nextRetryAt: z.number().nullable(),
		mode: z.enum(OS_STAGE_RECOVERY_MODES),
		reason: z.string().nullable(),
	})
	.strict()
	.refine(
		(record) =>
			record.mode !== 'unsafe' ||
			!['apt-exit-nonzero', 'commit_unit_absent_on_resume', 'commit_resume_inconclusive'].includes(
				record.reason ?? '',
			),
		{ message: 'Non-OS failure cannot be an unsafe OS staging record' },
	);
export type OsStageRecovery = z.infer<typeof osStageRecoverySchema>;

// The FULL persisted shape. `.strict()` so a corrupt/foreign agent.json (an
// unknown key) fails validation rather than silently round-tripping extra
// data — the resume path treats a failed parse as "no trustworthy persisted
// state", never as "trust it anyway". `osStageRecovery` is optional within
// schema 1: a file written before it existed stays valid, but a binary from
// before it existed rejects a file that carries it (strict) and starts fresh.
export const updateOrchestratorPersistedStateSchema = z
	.object({
		schema: z.literal(1),
		phase: updateOrchestratorPhaseSchema,
		enteredAt: z.number(),
		progress: updateOrchestratorProgressSchema.nullable(),
		failureReason: z.string().nullable(),
		packageCheck: updateOrchestratorScheduleClockSchema,
		osCheck: updateOrchestratorScheduleClockSchema,
		cellularOverrideId: z.string().nullable(),
		osStageRecovery: osStageRecoverySchema.optional(),
		osStageDiscoveryRetryAt: z.number().optional(),
	})
	.strict()
	.superRefine((state, ctx) => {
		const record = state.osStageRecovery;
		if (!record) return;
		const active = record.activeAttemptId !== null;
		const staging = state.phase === 'os-staging' || state.phase === 'os-staged';
		let consistent = active === staging && !(active && record.nextRetryAt !== null);
		if (active && record.attemptId !== undefined)
			consistent = consistent && record.attemptId === record.activeAttemptId;
		if (state.osStageDiscoveryRetryAt !== undefined) consistent = false;
		switch (record.mode) {
			case 'unsafe':
				consistent =
					consistent &&
					state.phase === 'failed' &&
					!active &&
					record.nextRetryAt === null &&
					record.reason !== null &&
					state.failureReason === record.reason;
				break;
			case 'operator':
				consistent = consistent && record.nextRetryAt === null;
				break;
			case 'automatic':
				consistent = consistent && (record.nextRetryAt === null || record.failedRounds > 0);
				break;
			default: {
				const unreachable: never = record.mode;
				return unreachable;
			}
		}
		if (!consistent)
			ctx.addIssue({
				code: 'custom',
				path: ['osStageRecovery'],
				message: 'OS recovery phase, attempt and retry policy disagree',
			});
	});
export type UpdateOrchestratorPersistedState = z.infer<
	typeof updateOrchestratorPersistedStateSchema
>;

// The additive wire projection. Every field optional except `phase`/`schema`
// so a legacy/uninitialized backend that has never persisted a state can still
// omit the whole block cleanly (the field itself stays `.optional()` on the
// status schemas below).
export const updateOrchestratorWireStateSchema = z.object({
	schema: z.literal(1),
	phase: updateOrchestratorPhaseSchema,
	progress: updateOrchestratorProgressSchema.nullable(),
	failure_reason: z.string().nullable(),
	cellular_override_id: z.string().nullable(),
});
export type UpdateOrchestratorWireState = z.infer<typeof updateOrchestratorWireStateSchema>;
