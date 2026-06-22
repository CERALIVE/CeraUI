/**
 * Per-RPC call logging interceptor.
 *
 * Wraps every oRPC procedure dispatch with a single debug-level trace line
 * carrying the procedure path, a short correlation id, wall-clock latency, and
 * the ok/err outcome. It is the biggest dev-visibility win for the RPC layer
 * (the audit flagged "no per-call logging, no request ids, no latency").
 *
 * The trace is OFF in production by default — gated on {@link isRpcTraceEnabled}
 * (development, or an explicit `LOG_LEVEL=debug`) so a shipped device never pays
 * the per-call cost nor floods `debug.log`.
 *
 * Security: auth procedures NEVER have their args logged — not even
 * redacted-partial. Args (password/token) are omitted entirely; only the
 * procedure name + outcome + cid are recorded. Every other procedure's args are
 * scrubbed through {@link logRedact} first.
 */

import { logger, logRedact } from "../helpers/logger.ts";
import {
	extractValidationDetails,
	type ValidationDetails,
} from "./error-enrichment.ts";
import type { RPCContext } from "./types.ts";

/**
 * Procedure-path namespaces whose ARGS must never be logged. The whole `auth.*`
 * surface (login/setPassword/logout) carries raw credentials in its input.
 */
const SENSITIVE_NAMESPACES: ReadonlySet<string> = new Set(["auth"]);

/** Length of the per-call correlation id (first hex chars of a UUIDv4). */
const CORRELATION_ID_LENGTH = 8;

/** Sub-millisecond rounding factor for the reported latency. */
const LATENCY_PRECISION = 1000;

/** Minimal logger surface the interceptor needs; the winston logger satisfies it. */
export interface RpcTraceSink {
	debug: (message: string, meta?: Record<string, unknown>) => void;
}

/** Injectable collaborators (DI seam for deterministic tests). */
export interface RpcLoggingDeps {
	sink: RpcTraceSink;
	now: () => number;
	genCorrelationId: () => string;
	isEnabled: () => boolean;
}

/** Structured per-call trace input. */
export interface RpcCallTrace {
	path: readonly string[];
	input: unknown;
	ok: boolean;
	latencyMs: number;
	cid: string;
	client?: string;
	validation?: ValidationDetails;
}

/**
 * Generate a short per-call correlation id: the first 8 hex chars of a UUIDv4
 * (the leading group, before the first hyphen — always hex). Short enough to
 * scan in a log, wide enough to disambiguate concurrent calls.
 */
export function newCorrelationId(): string {
	return crypto.randomUUID().slice(0, CORRELATION_ID_LENGTH);
}

/** True when the procedure path is in a credential-bearing namespace (`auth.*`). */
export function isSensitiveProcedure(path: readonly string[]): boolean {
	return path.length > 0 && SENSITIVE_NAMESPACES.has(path[0] ?? "");
}

/**
 * Gate: per-call traces are emitted only in development or when an operator
 * opts in with `LOG_LEVEL=debug`. Read fresh each call so the env can be flipped
 * (tests, runtime) without a reload.
 */
export function isRpcTraceEnabled(): boolean {
	if (process.env.LOG_LEVEL === "debug") {
		return true;
	}
	return process.env.NODE_ENV === "development";
}

/** Best-effort client label: relay sender id, else the socket's remote address. */
function clientLabel(context: unknown): string | undefined {
	try {
		const ctx = context as Partial<RPCContext> | undefined;
		const senderId = ctx?.getSenderId?.();
		if (senderId) {
			return senderId;
		}
		const addr = ctx?.ws?.remoteAddress;
		return typeof addr === "string" ? addr : undefined;
	} catch {
		// Logging must never throw; an odd context simply yields no client label.
		return undefined;
	}
}

function roundLatency(ms: number): number {
	return Math.round(ms * LATENCY_PRECISION) / LATENCY_PRECISION;
}

export const defaultRpcLoggingDeps: RpcLoggingDeps = {
	sink: {
		debug: (message, meta) => {
			if (meta !== undefined) {
				logger.debug(message, meta);
			} else {
				logger.debug(message);
			}
		},
	},
	now: () => performance.now(),
	genCorrelationId: newCorrelationId,
	isEnabled: isRpcTraceEnabled,
};

/**
 * Emit one structured debug line for a completed RPC call. No-op when the trace
 * gate is closed (production default). Auth args are dropped entirely; all other
 * args are redacted via {@link logRedact} before they ever reach a transport.
 */
export function logRpcCall(
	trace: RpcCallTrace,
	deps: RpcLoggingDeps = defaultRpcLoggingDeps,
): void {
	if (!deps.isEnabled()) {
		return;
	}

	const procedure = trace.path.join(".") || "<root>";
	const meta: Record<string, unknown> = {
		procedure,
		cid: trace.cid,
		latency_ms: roundLatency(trace.latencyMs),
		ok: trace.ok,
	};
	if (trace.client !== undefined) {
		meta.client = trace.client;
	}
	if (trace.validation !== undefined) {
		meta.validation = trace.validation;
	}
	// Auth procedures: args omitted entirely. Everything else: redacted.
	if (!isSensitiveProcedure(trace.path) && trace.input !== undefined) {
		meta.args = logRedact(trace.input);
	}

	deps.sink.debug(`RPC ${procedure} ${trace.ok ? "ok" : "err"}`, meta);
}

/**
 * Interceptor: wrap a single procedure dispatch with cid + latency + outcome
 * logging. The thunk runs unchanged on both paths (its result/throw is passed
 * straight through) so this is fully transparent to the RPC contract.
 *
 * When tracing is disabled the wrapper short-circuits to the thunk with no cid
 * or clock work, so the production hot path is untouched.
 */
export async function instrumentRpcCall<T>(
	path: readonly string[],
	input: unknown,
	context: unknown,
	run: () => Promise<T>,
	deps: RpcLoggingDeps = defaultRpcLoggingDeps,
): Promise<T> {
	if (!deps.isEnabled()) {
		return run();
	}

	const cid = deps.genCorrelationId();
	const client = clientLabel(context);
	const start = deps.now();

	const trace = (
		ok: boolean,
		validation?: ValidationDetails,
	): RpcCallTrace => ({
		path,
		input,
		ok,
		latencyMs: deps.now() - start,
		cid,
		...(client !== undefined ? { client } : {}),
		...(validation !== undefined ? { validation } : {}),
	});

	try {
		const result = await run();
		logRpcCall(trace(true), deps);
		return result;
	} catch (error) {
		logRpcCall(trace(false, extractValidationDetails(error)), deps);
		throw error;
	}
}
