/**
 * Start-lifecycle contract — the typed WIRE CONTRACT for the streaming
 * start/stop lifecycle (device-quality-wave2 Todo 25, DESIGN + SCHEMA ONLY).
 *
 * This module is the single source of truth for:
 *   (a) the wire RESULT UNION `StartResult = started | busy | cancelled | failed`
 *       and the `StartFailure` taxonomy it carries;
 *   (b) the stop-result union `stopping → stopped | stop_failed`;
 *   (e) the lifecycle state set + its legal transitions.
 *
 * `busy` and `cancelled` are FIRST-CLASS results, NOT failure classes: a later
 * change (Todo 26) returns them for concurrent-entry and stop-during-start. There
 * is deliberately NO `superseded` failure class — an attempt superseded/cancelled
 * by a stop terminates as the first-class `cancelled` result (one concept, one
 * representation).
 *
 * EVERY union variant is a discriminated wire object carrying `attemptId` so a
 * later change (Todo 29) can fence a stale response from an older attempt.
 *
 * Nothing here is wired into a runtime path — the start/stop RPC handlers,
 * retry loop, and suppression signals are Todos 26-29. This is browser-safe
 * (pure Zod + pure predicates, no Node/Bun deps) so both the backend producer
 * and the frontend renderer consume the identical types.
 */

import { z } from 'zod';

// ─── (a) StartFailure taxonomy ───────────────────────────────────────────────

/**
 * The phase of the start pipeline a failure surfaced in. Mirrors the real start
 * flow: input validation → sender spawn → engine connect → hello handshake →
 * event subscription → the `start` RPC → the wait for the engine to reach
 * PLAYING.
 */
export const START_FAILURE_PHASES = [
	'params',
	'spawn-sender',
	'connect',
	'hello',
	'subscribe',
	'start-rpc',
	'playing-wait',
] as const;
export const startFailurePhaseSchema = z.enum(START_FAILURE_PHASES);
export type StartFailurePhase = z.infer<typeof startFailurePhaseSchema>;

/**
 * The taxonomy class a failure is bucketed into. Deliberately small and
 * behaviour-oriented (retry vs surface vs update-prompt), NOT a 1:1 mirror of
 * every engine code — many codes collapse onto one class.
 *
 * There is NO `superseded` class: a stop-cancelled attempt is the first-class
 * `cancelled` StartResult, never a failure.
 */
export const START_FAILURE_CLASSES = [
	'engine_unavailable',
	'engine_restarting',
	'protocol_incompatible',
	'start_invalid',
	'engine_internal',
	'start_timeout',
] as const;
export const startFailureClassSchema = z.enum(START_FAILURE_CLASSES);
export type StartFailureClass = z.infer<typeof startFailureClassSchema>;

/**
 * A structured start failure. `attemptId` is REQUIRED on every failure (Todo 29
 * fences stale responses on it). `code` is the engine's numeric JSON-RPC code
 * (e.g. -32603) or its stable string data-code (e.g.
 * `cerastream.protocol.unsupported_version`) when the failure came from an
 * engine error response; absent for local/transport failures. `retriable` is
 * the MATERIALIZED verdict for THIS (class, phase) — see `isRetriableStartFailure`.
 */
export const startFailureSchema = z.object({
	attemptId: z.string(),
	phase: startFailurePhaseSchema,
	class: startFailureClassSchema,
	code: z.union([z.number(), z.string()]).optional(),
	retriable: z.boolean(),
});
export type StartFailure = z.infer<typeof startFailureSchema>;

// ─── (a) StartResult wire union — every variant echoes attemptId ─────────────

export const startResultSchema = z.discriminatedUnion('result', [
	z.object({ result: z.literal('started'), attemptId: z.string() }),
	z.object({ result: z.literal('busy'), attemptId: z.string() }),
	z.object({ result: z.literal('cancelled'), attemptId: z.string() }),
	z.object({
		result: z.literal('failed'),
		attemptId: z.string(),
		failure: startFailureSchema,
	}),
]);
export type StartResult = z.infer<typeof startResultSchema>;

// ─── (a) Stop-result wire union — stopping → stopped | stop_failed ───────────

export const stopResultSchema = z.discriminatedUnion('result', [
	z.object({ result: z.literal('stopping') }),
	z.object({ result: z.literal('stopped') }),
	z.object({ result: z.literal('stop_failed'), reason: z.string() }),
]);
export type StopResult = z.infer<typeof stopResultSchema>;

// ─── (e) Lifecycle state set + legal transitions ─────────────────────────────

/**
 * The backend lifecycle state set. `starting` is DISTINCT from `streaming`
 * (Todo 26: `is_streaming=true` only after engine confirmation); `reconciling`
 * is the boot/reconnect state where the backend queries the engine's actual
 * runtime state and adopts it; `stop_failed` is a terminal-until-retried state
 * a stop can land in.
 */
export const LIFECYCLE_STATES = [
	'idle',
	'starting',
	'streaming',
	'stopping',
	'stop_failed',
	'reconciling',
] as const;
export const lifecycleStateSchema = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;

/**
 * The complete set of LEGAL `[from, to]` transitions. Anything not listed is
 * illegal (an invariant violation Todo 26 turns into structured recovery, not a
 * silent state stomp). A self-loop is never a transition.
 */
export const LEGAL_LIFECYCLE_TRANSITIONS: ReadonlyArray<readonly [LifecycleState, LifecycleState]> =
	[
		// start requested / boot reconcile entry
		['idle', 'starting'],
		['idle', 'reconciling'],
		// launch outcomes
		['starting', 'streaming'], // engine confirmed PLAYING
		['starting', 'idle'], // terminal start failure OR cancelled-and-cleaned
		['starting', 'stopping'], // an explicit stop arrived mid-start
		['starting', 'reconciling'], // backend reconnect mid-start
		// running
		['streaming', 'stopping'],
		['streaming', 'reconciling'], // backend reconnect while streaming
		// stopping outcomes
		['stopping', 'idle'], // stopped
		['stopping', 'stop_failed'], // stop did not settle within the bound
		// stop recovery
		['stop_failed', 'stopping'], // retry the stop
		['stop_failed', 'idle'], // reconciled/abandoned to idle
		// reconcile outcomes — adopt the engine truth
		['reconciling', 'streaming'],
		['reconciling', 'idle'],
	] as const;

const LEGAL_TRANSITION_KEYS = new Set(
	LEGAL_LIFECYCLE_TRANSITIONS.map(([from, to]) => `${from}>${to}`),
);

/** True iff `from → to` is a declared legal lifecycle transition. */
export function isLegalLifecycleTransition(from: LifecycleState, to: LifecycleState): boolean {
	return LEGAL_TRANSITION_KEYS.has(`${from}>${to}`);
}

// ─── (d) Retriability — every class carries an explicit WHY ───────────────────

/**
 * Per-class retriability metadata. `retriablePhases` is the exact set of phases
 * on which the class is retriable (empty = never); `why` is the required one-line
 * rationale — a bare boolean is not a decision.
 *
 * Retriability is phase-scoped to the connection-establishment phases because a
 * failure BEFORE the engine has accepted the start (connect/hello) is a
 * boot/restart race a clean re-dial resolves, whereas a failure AFTER
 * (subscribe/start-rpc/playing-wait) means the engine accepted us then faltered
 * mid-start — a blind retry there would stack a duplicate/half-applied start, so
 * Todo 27 rolls back and escalates instead.
 */
export const START_FAILURE_RETRIABILITY: Record<
	StartFailureClass,
	{ retriablePhases: readonly StartFailurePhase[]; why: string }
> = {
	engine_unavailable: {
		retriablePhases: ['connect', 'hello'],
		why: 'The engine is not answering yet (ENOENT/refused/dropped while connecting); a bounded retry across the boot/restart window reconnects with no operator action — but only before the start is accepted.',
	},
	engine_restarting: {
		retriablePhases: ['connect', 'hello'],
		why: 'A known systemd RestartSec=5 restart is in flight; retrying across the restart window reaches the fresh engine — only while still establishing the connection.',
	},
	start_timeout: {
		retriablePhases: ['connect'],
		why: 'A connect-phase timeout is a slow-boot race and retries cleanly; a timeout AFTER connect means a half-applied start on a wedged engine, so a retry would stack a duplicate start — escalate instead.',
	},
	protocol_incompatible: {
		retriablePhases: [],
		why: 'An engine/bindings protocol-major mismatch is deterministic — the same binaries never negotiate on retry, so surface an update prompt instead of looping.',
	},
	start_invalid: {
		retriablePhases: [],
		why: 'Invalid params/config are deterministic — an identical retry fails identically, so the operator (or cloud) must fix the input first.',
	},
	engine_internal: {
		retriablePhases: [],
		why: 'A deterministic engine-side fault or state conflict (e.g. already_streaming / -32603); retrying masks a real bug and can orphan resources — surface with a journal pointer.',
	},
};

/** The materialized retriability verdict for a concrete (class, phase). */
export function isRetriableStartFailure(cls: StartFailureClass, phase: StartFailurePhase): boolean {
	return START_FAILURE_RETRIABILITY[cls].retriablePhases.includes(phase);
}
