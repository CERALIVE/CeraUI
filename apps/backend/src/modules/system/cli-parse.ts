/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Shared "fail-loud" CLI-output parsing primitives (S2 hardening).
 *
 * The device control plane shells out to mmcli / nmcli / systemctl / ip and
 * parses their human-oriented output with regex + split. When that output
 * drifts (a firmware bump, a locale change, a NetworkManager version skew) an
 * inline parser silently produces a WRONG value — a missing modem, a bogus
 * UUID, a route that never installs — and nothing is logged. That class of
 * silent corruption is exactly what this module exists to prevent:
 *
 *  - Named parser functions return a typed {@link ParseResult} instead of a
 *    raw value, so the call site MUST handle the drift branch explicitly.
 *  - {@link logParseError} records the drift (with a bounded slice of the raw
 *    output) at WARN, so a production device surfaces the problem instead of
 *    feeding a wrong value downstream.
 *  - {@link describeCliError} stops the other half of the leak: the runner
 *    (`helpers/run.ts`) already captures stderr + the exit code on a non-zero
 *    exit, but most call sites logged only `err.message` and DISCARDED both.
 *    This renders all three so a failure says *why*, not just "Command failed".
 */

import { logger } from "../../helpers/logger.ts";

/** Max characters of raw CLI output retained in a parse-error / log line. */
export const MAX_RAW_PARSE_CHARS = 600;

/** A typed parse failure: the CLI output did not match the expected shape. */
export type ParseError = {
	readonly ok: false;
	readonly kind: "parse-error";
	/** Name of the parser that rejected the output (for the log + caller). */
	readonly parser: string;
	/** Why the output failed to parse, in human terms. */
	readonly reason: string;
	/** Bounded slice of the offending raw output (for the log). */
	readonly raw: string;
};

/** Discriminated result of a named CLI-output parser. */
export type ParseResult<T> = { readonly ok: true; readonly value: T } | ParseError;

/** Wrap a successfully parsed value. */
export function parseOk<T>(value: T): { readonly ok: true; readonly value: T } {
	return { ok: true, value };
}

/** Build a typed parse-error, truncating the raw output to a safe bound. */
export function parseFail(
	parser: string,
	reason: string,
	raw: string,
): ParseError {
	return {
		ok: false,
		kind: "parse-error",
		parser,
		reason,
		raw: truncateRaw(raw),
	};
}

/** Narrow an unknown value (or a ParseResult) to a {@link ParseError}. */
export function isParseError(value: unknown): value is ParseError {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "parse-error"
	);
}

/**
 * Log a parse-error at WARN with its bounded raw output, then return it
 * unchanged so a call site can `return logParseError(err)` in one expression.
 */
export function logParseError(err: ParseError): ParseError {
	logger.warn(`CLI output drift in ${err.parser}: ${err.reason}`, {
		raw: err.raw,
	});
	return err;
}

/**
 * Render a thrown CLI error including the captured stderr + exit code.
 *
 * `helpers/exec.ts#execFileP` rejects non-zero exits with an Error carrying
 * `.stdout` / `.stderr` / `.code`; this surfaces the stderr + code that the
 * call sites used to throw away. NEVER pass this an error from a SECRET-bearing
 * argv (PIN/PUK/password): `err.message` embeds the full argv, so those call
 * sites log a redacted summary instead.
 */
export function describeCliError(err: unknown): string {
	if (typeof err === "object" && err !== null) {
		const e = err as { message?: unknown; stderr?: unknown; code?: unknown };
		const parts: string[] = [];
		if (typeof e.message === "string" && e.message) parts.push(e.message);
		if (typeof e.code === "number") parts.push(`exit=${e.code}`);
		const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
		if (stderr) parts.push(`stderr: ${truncateRaw(stderr)}`);
		if (parts.length > 0) return parts.join(" ");
	}
	return err instanceof Error ? err.message : String(err);
}

function truncateRaw(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length <= MAX_RAW_PARSE_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_RAW_PARSE_CHARS)}…(${trimmed.length} chars)`;
}
