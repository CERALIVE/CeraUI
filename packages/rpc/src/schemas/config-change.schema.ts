/**
 * Live config-change contract — the CeraUI mirror of the cerastream
 * `change-config` transaction (engine wave-3 Todo 9, engine schema `0.10.0`).
 *
 * WHY THIS FILE EXISTS AT ALL: the engine publishes a worst-case transaction
 * bound so a client can size its own timeout from a declared number instead of
 * guessing, but the published `@ceralive/cerastream` bindings deliberately do
 * NOT ship that constant (it lives in the engine's `bin` crate, not in
 * `cerastream-ipc`). So CeraUI has to carry it — and carrying it as a bare
 * `65_000` typed into an orchestrator would be exactly the silent hardcode the
 * bindings note warned against. The DERIVATION is reproduced below instead, and
 * `config-change.schema.test.ts` asserts it still totals the number
 * `cerastream/docs/adr/schema.md` §11 publishes. Shrink an engine phase budget
 * without updating this table and the test goes red rather than the device
 * quietly mis-reporting a healthy transaction as hung.
 *
 * Lives in `@ceraui/rpc` (not in the backend) for the same reason the
 * device-mode-truth rule does: BOTH the backend orchestrator (which sizes its
 * `reconfiguring` deadline from it) and the frontend (which renders the
 * `applying` progress state against it) must agree by construction.
 */

import { z } from 'zod';

/**
 * Per-phase deadlines of ONE `change-config` transaction, in milliseconds.
 * Verbatim from `cerastream/docs/adr/schema.md` §11.
 */
export const CHANGE_CONFIG_PHASE_DEADLINES_MS = {
	teardown: 5_000,
	build: 8_000,
	connect: 8_000,
	play: 6_000,
	gate: 3_000,
} as const;

/**
 * THREE, not two. A transaction tears down the live session, the failed
 * replacement, AND the failed rollback session — the third unwind is not
 * optional, because a rollback session that reached PLAYING but failed the gate
 * still holds the capture device until it is unwound in order.
 */
export const CHANGE_CONFIG_MAX_TEARDOWNS = 3;

/** The replacement attempt plus the single rollback attempt. There is no retry loop. */
export const CHANGE_CONFIG_MAX_START_ATTEMPTS = 2;

export const CHANGE_CONFIG_ONE_START_MS =
	CHANGE_CONFIG_PHASE_DEADLINES_MS.build +
	CHANGE_CONFIG_PHASE_DEADLINES_MS.connect +
	CHANGE_CONFIG_PHASE_DEADLINES_MS.play +
	CHANGE_CONFIG_PHASE_DEADLINES_MS.gate;

/**
 * The engine's DECLARED worst case: `3 × teardown + 2 × start`, NOT the
 * intuitive `attempt × 2`. An earlier draft published 60 000 on the latter
 * reading; a healthy transaction can legitimately exceed that, which would have
 * had CeraUI report working hardware as hung.
 */
export const CHANGE_CONFIG_WORST_CASE_BOUND_MS =
	CHANGE_CONFIG_MAX_TEARDOWNS * CHANGE_CONFIG_PHASE_DEADLINES_MS.teardown +
	CHANGE_CONFIG_MAX_START_ATTEMPTS * CHANGE_CONFIG_ONE_START_MS;

export const CONFIG_CHANGE_PHASES = ['applying', 'applied', 'reverted', 'rollback_failed'] as const;
export const configChangePhaseSchema = z.enum(CONFIG_CHANGE_PHASES);
export type ConfigChangePhase = z.infer<typeof configChangePhaseSchema>;

export const CONFIG_CHANGE_TERMINAL_PHASES = ['applied', 'reverted', 'rollback_failed'] as const;

export function isTerminalConfigChangePhase(phase: ConfigChangePhase): boolean {
	return (CONFIG_CHANGE_TERMINAL_PHASES as readonly string[]).includes(phase);
}

/**
 * The engine's distinct reason for a teardown-deadline overrun. It is a
 * SUPERVISOR ESCALATION, not an ordinary rollback failure: the engine could not
 * prove the old session released its devices, so it refuses to build a
 * replacement and goes Idle. CeraUI must therefore expect the engine to EXIT the
 * session after this reason, and must leave `reconfiguring` rather than wait.
 */
export const CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT = 'teardown_timeout';

/** CeraUI's own reason for a transaction that outlived the declared bound. */
export const CONFIG_CHANGE_REASON_DEADLINE = 'change_deadline_exceeded';

/** CeraUI's own reason for a transaction whose engine connection died mid-flight. */
export const CONFIG_CHANGE_REASON_ENGINE_LOST = 'engine_connection_lost';

/**
 * CeraUI's own reason for a transaction the engine REFUSED before starting it.
 *
 * The engine answers `Ok` for every phase it actually reached and returns a
 * JSON-RPC ERROR only when the transaction never began — so a structured engine
 * rejection means the live session was never touched and the PREVIOUS config is
 * still running. That is `reverted`, not `rollback_failed`: nothing was torn
 * down, so there was no rollback to fail. Reporting it as `rollback_failed` (and
 * worse, as `engine_connection_lost`) tells the operator their broadcast may be
 * dead when it is streaming normally — the exact dishonesty this contract
 * exists to prevent. Confirmed live on a board, where an unsupported encode
 * parameter surfaced as `rollback_failed{engine_connection_lost}` while the
 * engine kept encoding without interruption.
 */
export const CONFIG_CHANGE_REASON_REJECTED = 'change_rejected';

export const CONFIG_CHANGE_EVENT = 'config-change';

/**
 * A config-change phase as broadcast to the UI. `attemptId` is what the frontend
 * store fences on — a phase from a superseded attempt is ignored, never rendered.
 */
export const configChangeStateSchema = z.object({
	attemptId: z.string(),
	phase: configChangePhaseSchema,
	reason: z.string().optional(),
});
export type ConfigChangeState = z.infer<typeof configChangeStateSchema>;

/**
 * The fields an apply-now change may carry. Deliberately the SUBSET that cannot
 * be changed on a live graph — resolution, framerate, codec and source are baked
 * in at build time, which is exactly why they need a transaction rather than a
 * `reload-config`.
 */
export const CONFIG_CHANGE_FIELDS = ['source', 'resolution', 'framerate', 'video_codec'] as const;
export type ConfigChangeField = (typeof CONFIG_CHANGE_FIELDS)[number];

export const configChangeResultSchema = z.discriminatedUnion('result', [
	z.object({ result: z.literal('applied'), attemptId: z.string() }),
	z.object({ result: z.literal('reverted'), attemptId: z.string(), reason: z.string().optional() }),
	z.object({
		result: z.literal('rollback_failed'),
		attemptId: z.string(),
		reason: z.string().optional(),
	}),
	z.object({ result: z.literal('busy') }),
	z.object({ result: z.literal('rejected'), reason: z.string() }),
]);
export type ConfigChangeResult = z.infer<typeof configChangeResultSchema>;
