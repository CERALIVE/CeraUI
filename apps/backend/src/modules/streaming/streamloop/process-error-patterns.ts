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

// TRANSITIONAL — superseded by cerastream structured IPC (plan Task 32).
//
// Single source of truth for the stderr-pattern → user-notification mapping the
// streamloop applies to the supervised srtla_send / ceracoder processes. Today
// the only signal those C processes give us is free-form stderr text, so we
// pattern-match it here. Task 32 replaces the text scraping with cerastream's
// structured IPC error codes — at which point this becomes a table swap (map a
// typed wire code → the same { code, message } row) rather than a rewrite.
//
// Keep ALL stderr regexes here. start-stream.ts must not match stderr inline.

/** Stable, typed error codes the pattern table resolves to. */
export const PROCESS_ERROR_CODES = {
	SRTLA_INITIAL_CONNECT_FAILED: "srtla_initial_connect_failed",
	SRTLA_NO_CONNECTIONS: "srtla_no_connections",
	CAPTURE_AUDIO_ERROR: "capture_audio_error",
	CAPTURE_VIDEO_ERROR: "capture_video_error",
	PIPELINE_STALL: "pipeline_stall",
	SRT_CONNECT_FAILED: "srt_connect_failed",
	SRT_CONNECTION_LOST: "srt_connection_lost",
} as const;

export type ProcessErrorCode =
	(typeof PROCESS_ERROR_CODES)[keyof typeof PROCESS_ERROR_CODES];

/** Which supervised process produced the stderr (also the notification channel). */
export type ProcessSource = "srtla" | "ceracoder";

export interface ProcessErrorPattern {
	/** Typed code (Task 32 maps cerastream IPC codes onto these). */
	code: ProcessErrorCode;
	/** Process whose stderr this row matches. */
	source: ProcessSource;
	/** stderr matcher. The ONLY place these regexes are allowed to live. */
	pattern: RegExp;
	/** Static user-facing message, or a deriver from the matched stderr line. */
	message: string | ((stderr: string) => string);
	/**
	 * When true, the caller must suppress the notification if an srtla error is
	 * already on screen — avoids stacking a redundant ceracoder-side SRT error on
	 * top of the srtla connection error the user is already seeing.
	 */
	suppressIfSrtlaNotified?: boolean;
}

export interface ResolvedProcessError {
	code: ProcessErrorCode;
	message: string;
	suppressIfSrtlaNotified: boolean;
}

// Reason extraction for the ceracoder SRT-connect failure: the C side appends a
// human reason (`Failed to establish an SRT connection: <reason>.`). Surface it
// in parentheses when present so the user sees WHY the connect failed.
const SRT_CONNECT_REASON_RE =
	/Failed to establish an SRT connection: ([\w ]+)\./;

function srtConnectFailedMessage(stderr: string): string {
	const reasonMatch = stderr.match(SRT_CONNECT_REASON_RE);
	const reason = reasonMatch?.[1] ? ` (${reasonMatch[1]})` : "";
	return `Failed to connect to the SRT server${reason}. Retrying...`;
}

/**
 * Ordered stderr-pattern table. Matched top-to-bottom per source; the first hit
 * wins (mirrors the original if/else-if chain ordering in start-stream.ts).
 */
export const PROCESS_ERROR_PATTERNS: ReadonlyArray<ProcessErrorPattern> = [
	{
		code: PROCESS_ERROR_CODES.SRTLA_INITIAL_CONNECT_FAILED,
		source: "srtla",
		pattern: /Failed to establish any initial connections/,
		message: "Failed to connect to the SRTLA server. Retrying...",
	},
	{
		code: PROCESS_ERROR_CODES.SRTLA_NO_CONNECTIONS,
		source: "srtla",
		pattern: /no available connections/,
		message: "All SRTLA connections failed. Trying to reconnect...",
	},
	{
		code: PROCESS_ERROR_CODES.CAPTURE_AUDIO_ERROR,
		source: "ceracoder",
		pattern: /gstreamer error from alsasrc0/,
		message: "Capture card error (audio). Trying to restart...",
	},
	{
		code: PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR,
		source: "ceracoder",
		pattern: /gstreamer error from v4l2src0/,
		message: "Capture card error (video). Trying to restart...",
	},
	{
		code: PROCESS_ERROR_CODES.PIPELINE_STALL,
		source: "ceracoder",
		pattern: /Pipeline stall detected/,
		message: "The input source has stalled. Trying to restart...",
	},
	{
		code: PROCESS_ERROR_CODES.SRT_CONNECT_FAILED,
		source: "ceracoder",
		pattern: /Failed to establish an SRT connection/,
		message: srtConnectFailedMessage,
		suppressIfSrtlaNotified: true,
	},
	{
		code: PROCESS_ERROR_CODES.SRT_CONNECTION_LOST,
		source: "ceracoder",
		pattern: /The SRT connection.+, exiting/,
		message: "The SRT connection failed. Trying to reconnect...",
		suppressIfSrtlaNotified: true,
	},
];

/**
 * Resolve a stderr line from `source` to its typed error + user message, or
 * `undefined` when no pattern matches. Suppression (whether an srtla error is
 * already on screen) is the caller's decision — this stays pure/testable — but
 * the `suppressIfSrtlaNotified` flag tells the caller when to apply it.
 */
export function resolveProcessError(
	source: ProcessSource,
	stderr: string,
): ResolvedProcessError | undefined {
	for (const entry of PROCESS_ERROR_PATTERNS) {
		if (entry.source !== source) continue;
		if (!entry.pattern.test(stderr)) continue;
		const message =
			typeof entry.message === "function"
				? entry.message(stderr)
				: entry.message;
		return {
			code: entry.code,
			message,
			suppressIfSrtlaNotified: entry.suppressIfSrtlaNotified ?? false,
		};
	}
	return undefined;
}
