/**
 * oRPC validation-error enrichment for adapter diagnostics.
 *
 * The WS adapter dispatches procedures by calling oRPC's `call()` manually
 * (outside an RPCHandler pipeline), so failures arrive as a thrown error rather
 * than an interceptor callback. This module turns that opaque error into a
 * structured, log-safe shape: which phase the validation broke in (input vs
 * output) and the Zod field paths that failed.
 *
 * Phase is read straight off oRPC's own wrapper. A failed INPUT schema is
 * raised as `ORPCError("BAD_REQUEST", { message: "Input validation failed",
 * cause: ValidationError })`; a failed OUTPUT schema as
 * `ORPCError("INTERNAL_SERVER_ERROR", { message: "Output validation failed",
 * cause: ValidationError })`. We classify from those messages (then the error
 * code as a fallback). A raw `ZodError` carries no phase signal, so it maps to
 * `"unknown"` — never a fabricated "input"/"output" claim.
 *
 * Security: issue paths are schema field names (safe), but messages can echo
 * caller-supplied text, so every emitted string is scrubbed through
 * {@link logRedact}. This module never logs raw input/output values.
 */

import { logRedact } from "../helpers/logger.ts";

/** Single Zod/standard-schema issue, flattened to log-safe primitives. */
export interface ValidationIssueDetail {
	path: string;
	message: string;
	code: string;
}

export type ValidationPhase = "input" | "output" | "unknown";

export interface ValidationDetails {
	phase: ValidationPhase;
	issues: ValidationIssueDetail[];
}

interface RawIssue {
	path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
	message?: unknown;
	code?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** Locate the issue list, whether on the error itself, its cause, or its data. */
function findIssues(error: unknown): RawIssue[] | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
		const record = asRecord(current);
		if (!record || seen.has(current)) {
			break;
		}
		seen.add(current);
		if (Array.isArray(record.issues)) {
			return record.issues as RawIssue[];
		}
		const data = asRecord(record.data);
		if (data && Array.isArray(data.issues)) {
			return data.issues as RawIssue[];
		}
		current = record.cause;
	}
	return undefined;
}

/** Concatenate the error + its cause messages so phase can be classified. */
function collectMessages(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
		const record = asRecord(current);
		if (!record) {
			break;
		}
		if (typeof record.message === "string") {
			parts.push(record.message);
		}
		current = record.cause;
	}
	return parts.join(" ");
}

function detectPhase(error: unknown): ValidationPhase {
	const messages = collectMessages(error);
	if (/input validation failed/i.test(messages)) {
		return "input";
	}
	if (/output validation failed/i.test(messages)) {
		return "output";
	}
	const code = asRecord(error)?.code;
	if (code === "BAD_REQUEST") {
		return "input";
	}
	if (code === "INTERNAL_SERVER_ERROR") {
		return "output";
	}
	return "unknown";
}

function segmentKey(segment: PropertyKey | { key: PropertyKey }): string {
	if (typeof segment === "object" && segment !== null && "key" in segment) {
		return String(segment.key);
	}
	return String(segment);
}

function mapIssue(issue: RawIssue): ValidationIssueDetail {
	const path = Array.isArray(issue.path)
		? issue.path.map(segmentKey).join(".")
		: "";
	const message = typeof issue.message === "string" ? issue.message : "";
	const code =
		typeof issue.code === "string"
			? issue.code
			: issue.code != null
				? String(issue.code)
				: "";
	return {
		path: String(logRedact(path)),
		message: String(logRedact(message)),
		code,
	};
}

/**
 * Extract phase + field-path details from an oRPC/Zod validation failure.
 * Returns `undefined` when the error is not validation-shaped (no issue list),
 * so callers can omit the field rather than log an empty record.
 */
export function extractValidationDetails(
	error: unknown,
): ValidationDetails | undefined {
	const issues = findIssues(error);
	if (!issues) {
		return undefined;
	}
	return { phase: detectPhase(error), issues: issues.map(mapIssue) };
}
