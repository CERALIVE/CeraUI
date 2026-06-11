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

// The "table swap" the TRANSITIONAL stderr table (process-error-patterns.ts)
// promised for Task 32: cerastream reports a STRUCTURED Tier-2 error code over
// IPC, so we look the user-message up BY CODE instead of regex-scraping stderr.
// The static messages + the suppress flags are lifted verbatim from the shared
// Task-7 table (the single source of truth), so the two stay in lockstep; this
// module itself contains NO stderr regex (the structured code is the key).

import type {
	ProcessErrorCode,
	ProcessErrorSource,
} from "@ceralive/cerastream";
import {
	PROCESS_ERROR_CODES,
	PROCESS_ERROR_PATTERNS,
} from "./streamloop/process-error-patterns.ts";

const SUPPRESS_IF_SRTLA_NOTIFIED = new Set<ProcessErrorCode>();
const STATIC_MESSAGE = new Map<ProcessErrorCode, string>();
for (const row of PROCESS_ERROR_PATTERNS) {
	if (row.suppressIfSrtlaNotified) SUPPRESS_IF_SRTLA_NOTIFIED.add(row.code);
	if (typeof row.message === "string")
		STATIC_MESSAGE.set(row.code, row.message);
}

/** Notification channel CeraUI routes the resolved error onto. */
export type CerastreamErrorChannel = "srtla" | "cerastream";

export interface ResolvedCerastreamError {
	code: ProcessErrorCode;
	message: string;
	suppressIfSrtlaNotified: boolean;
	channel: CerastreamErrorChannel;
}

/**
 * Resolve a structured cerastream Tier-2 runtime-error event to the user-facing
 * notification CeraUI shows — the structured counterpart of
 * `resolveProcessError` (process-error-patterns.ts), keyed on the wire code
 * rather than a stderr match.
 */
export function resolveCerastreamError(
	code: ProcessErrorCode,
	source: ProcessErrorSource,
	reason?: string,
): ResolvedCerastreamError {
	return {
		code,
		message: messageFor(code, reason),
		suppressIfSrtlaNotified: SUPPRESS_IF_SRTLA_NOTIFIED.has(code),
		channel: source === "srtla" ? "srtla" : "cerastream",
	};
}

function messageFor(code: ProcessErrorCode, reason?: string): string {
	const fixed = STATIC_MESSAGE.get(code);
	if (fixed !== undefined) return fixed;

	// srt_connect_failed is the only Task-7 row whose message folds in a runtime
	// <reason>; the structured event carries it as a field instead of stderr text.
	if (code === PROCESS_ERROR_CODES.SRT_CONNECT_FAILED) {
		const detail = reason ? ` (${reason})` : "";
		return `Failed to connect to the SRT server${detail}. Retrying...`;
	}

	return `Engine error: ${code}`;
}
