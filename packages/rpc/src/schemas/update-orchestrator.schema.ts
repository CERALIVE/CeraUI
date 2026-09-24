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

// The FULL persisted shape. `.strict()` so a corrupt/foreign agent.json (an
// unknown key) fails validation rather than silently round-tripping extra
// data — the resume path treats a failed parse as "no trustworthy persisted
// state", never as "trust it anyway".
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
	})
	.strict();
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
