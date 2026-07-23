/**
 * Start-failure taxonomy — the MAPPING layer for the start-lifecycle contract
 * (device-quality-wave2 Todo 25, DESIGN + SCHEMA ONLY).
 *
 * The wire types live in `@ceraui/rpc/schemas` (`streaming-lifecycle.schema.ts`).
 * This module is the backend-side mapping table + helpers that turn a concrete
 * failure at a known start-path site into a typed `StartFailure`, plus the
 * attempt-id generator (b), the retry policy (d), and the suppression-window
 * predicate (c). It consumes the external `@ceralive/cerastream` error classes
 * (which own the ENOENT/refused wrapping, hello/subscribe/request timeouts, and
 * the JSON-RPC codes) — so those live behind the client, and CeraUI classifies
 * their surfaced shapes here.
 *
 * Todo 26 wired this taxonomy into the public start boundary and carries one
 * attempt id through the orchestrator. Todo 28 consumes the policy below for
 * bounded retries and suppression. This module stays pure and fully unit-tested
 * against fabricated error shapes.
 *
 * ── Failure-site cross-check (every site found in the codebase, mapped) ──
 *   params        zod (oRPC input / validateConfig safeParse / startParams.parse)
 *                 + plain validation Errors            → start_invalid
 *   connect       CerastreamConnectionError (ENOENT/ECONNREFUSED wrapped in the
 *                 client)                              → engine_unavailable (retriable)
 *   connect       CerastreamTimeoutError               → start_timeout (retriable)
 *   hello         CerastreamRpcError -32000 / ZodError → protocol_incompatible
 *   hello         CerastreamConnectionError (close)    → engine_unavailable
 *   hello         CerastreamTimeoutError               → start_timeout (not retriable)
 *   subscribe     CerastreamTimeoutError               → start_timeout (not retriable)
 *   subscribe     CerastreamConnectionError            → engine_unavailable (not retriable)
 *   start-rpc     -32602 params.invalid / -32003       → start_invalid
 *   start-rpc     -32002 already / -32603 internal     → engine_internal
 *   start-rpc     CerastreamTimeoutError (10s request) → start_timeout (not retriable)
 *   playing-wait  CerastreamTimeoutError               → start_timeout (not retriable)
 *   (unmapped)    any opaque shape                     → engine_internal + logged warn
 */

import {
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
} from "@ceralive/cerastream";
import {
	isRetriableStartFailure,
	type StartFailure,
	type StartFailureClass,
	type StartFailurePhase,
} from "@ceraui/rpc/schemas";

import { randomBase64 } from "../../helpers/crypto.ts";

export class StreamStartFailure extends Error {
	override readonly name = "StreamStartFailure";

	constructor(readonly failure: StartFailure) {
		super(`${failure.phase}:${failure.class}`);
	}
}

// ─── (b) Attempt-ID generation at the public start boundary ──────────────────

// Monotonic-ish component so ids sort roughly by creation time in logs, plus a
// random suffix for uniqueness within the same millisecond. Generated once per
// public `start` entry and carried through queue/logs/notification (Todo 26).
export function newAttemptId(): string {
	const ts = Date.now().toString(36);
	const rand = randomBase64(6)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, 8);
	return `att_${ts}_${rand}`;
}

// ─── (a) The mapping table ────────────────────────────────────────────────────

// The known JSON-RPC numeric codes → taxonomy class. Anything not in this table
// (including a novel engine code) falls through to `engine_internal`.
const RPC_CODE_TO_CLASS: Record<number, StartFailureClass> = {
	[-32000]: "protocol_incompatible", // cerastream.protocol.unsupported_version
	[-32602]: "start_invalid", // cerastream.params.invalid
	[-32003]: "start_invalid", // cerastream.device.not_found
	[-32002]: "engine_internal", // cerastream.state.already_streaming (engine-side state conflict)
	[-32603]: "engine_internal", // cerastream.internal
};

function isZodLikeError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: string }).name === "ZodError"
	);
}

export interface ClassifyDeps {
	warn: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultClassifyDeps: ClassifyDeps = {
	warn: () => {
		/* default no-op; the real wiring (Todo 28) injects the logger */
	},
};

/**
 * Classify a concrete failure at a known start-path `phase` into a typed
 * `StartFailure`. NEVER throws: an unmapped/opaque shape is bucketed as
 * `engine_internal` and a warning is emitted so the drop-through is observable.
 */
export function classifyStartFailure(
	phase: StartFailurePhase,
	error: unknown,
	attemptId: string,
	deps: ClassifyDeps = defaultClassifyDeps,
): StartFailure {
	const { cls, code } = classifyClass(phase, error, deps);
	return {
		attemptId,
		phase,
		class: cls,
		...(code !== undefined ? { code } : {}),
		retriable: isRetriableStartFailure(cls, phase),
	};
}

function classifyClass(
	phase: StartFailurePhase,
	error: unknown,
	deps: ClassifyDeps,
): { cls: StartFailureClass; code?: number | string } {
	// A timeout is always a timeout, whatever the phase — retriability is derived
	// per-phase downstream (connect-only) so we don't decide it here.
	if (error instanceof CerastreamTimeoutError) {
		return { cls: "start_timeout" };
	}

	// A lost/unreachable control connection means the engine isn't answering.
	if (error instanceof CerastreamConnectionError) {
		return { cls: "engine_unavailable" };
	}

	// A structured engine error response — map by its numeric JSON-RPC code. The
	// carried `code` is the canonical NUMERIC JSON-RPC code (the stable machine
	// identity the taxonomy enumerates: -32000/-32602/-32002/-32003/-32603); the
	// human-readable string dataCode stays available on the raw error for logs.
	if (error instanceof CerastreamRpcError) {
		const mapped = RPC_CODE_TO_CLASS[error.code];
		if (mapped !== undefined) {
			return { cls: mapped, code: error.code };
		}
		// A real engine error with an unknown code is an engine-side fault.
		return { cls: "engine_internal", code: error.code };
	}

	// A Zod validation failure: params-phase → invalid config; hello-phase →
	// the engine spoke an incompatible hello shape.
	if (isZodLikeError(error)) {
		return {
			cls: phase === "hello" ? "protocol_incompatible" : "start_invalid",
		};
	}

	// Any other Error in the params/spawn phase is a local validation/setup fault.
	if (
		error instanceof Error &&
		(phase === "params" || phase === "spawn-sender")
	) {
		return { cls: "start_invalid" };
	}

	// Unmapped/opaque — never throw. Bucket as engine_internal + a warning so the
	// drop-through is visible (the Todo-25 failure QA scenario).
	deps.warn("start-failure-taxonomy: unmapped error shape → engine_internal", {
		phase,
		errorName: error instanceof Error ? error.name : typeof error,
	});
	return { cls: "engine_internal" };
}

// ─── (d) Retry policy — bounded exponential backoff, retriable classes only ──

export interface RetryPolicy {
	/** Hard cap on the number of start attempts (including the first). */
	maxAttempts: number;
	/** Total wall-clock budget across all attempts, in ms. */
	totalBudgetMs: number;
	/** First backoff delay, in ms. */
	baseDelayMs: number;
	/** Backoff ceiling, in ms. */
	maxDelayMs: number;
}

// Defaults chosen against the supervision windows (systemd RestartSec=5,
// crash-loop 5/60s): a few short retries that comfortably span one restart
// window, then escalate.
export const DEFAULT_START_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 5,
	totalBudgetMs: 60_000,
	baseDelayMs: 2_000,
	maxDelayMs: 16_000,
};

/** Bounded exponential backoff for attempt `n` (0-based): base·2^n, capped. */
export function nextBackoffDelayMs(
	attempt: number,
	policy: RetryPolicy = DEFAULT_START_RETRY_POLICY,
): number {
	const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt);
	return Math.min(raw, policy.maxDelayMs);
}

export interface RetryProgress {
	/** Attempts made so far (>= 1 after the first attempt). */
	attempts: number;
	/** Wall-clock ms elapsed since the first attempt. */
	elapsedMs: number;
}

/**
 * Whether to schedule another start attempt after `failure`. Retries ONLY a
 * retriable failure (the class/phase verdict on the failure itself), and only
 * while both the attempt count and the total-time budget remain.
 */
export function shouldRetryStart(
	failure: StartFailure,
	progress: RetryProgress,
	policy: RetryPolicy = DEFAULT_START_RETRY_POLICY,
): boolean {
	if (!failure.retriable) return false;
	if (progress.attempts >= policy.maxAttempts) return false;
	if (progress.elapsedMs >= policy.totalBudgetMs) return false;
	return true;
}

// ─── (c) Suppression window — sourced from EXISTING signals ──────────────────

/**
 * The inputs to the suppression decision, each sourced from an EXISTING backend
 * signal (Todo 28 binds them; this is the pure predicate + its shape):
 *   - `softwareUpdateActive`   ← `isUpdating()` (software-updates module)
 *   - `engineRestartWindow`    ← the engine-reconnect capability state
 *                                (`engineUnavailable`/`engineStarting`) inside the
 *                                systemd RestartSec=5 window
 *   - `bootWindow`             ← the boot-readiness window (health/readiness module)
 *   - `cancelledByStop`        ← the attempt was cancelled by a stop (first-class
 *                                `cancelled` result — it notifies nothing)
 */
export interface SuppressionContext {
	softwareUpdateActive: boolean;
	engineRestartWindow: boolean;
	bootWindow: boolean;
	cancelledByStop: boolean;
}

/**
 * True when a TRANSIENT (retriable) failure should show a calm "engine
 * starting…" state instead of an error notification, because a known window
 * explains it. A REAL terminal failure (budget exhausted, non-retriable class)
 * is never suppressed — that gating lives in the retry loop (Todo 28), not here.
 */
export function shouldSuppressTransientFailure(
	ctx: SuppressionContext,
): boolean {
	return (
		ctx.softwareUpdateActive ||
		ctx.engineRestartWindow ||
		ctx.bootWindow ||
		ctx.cancelledByStop
	);
}
