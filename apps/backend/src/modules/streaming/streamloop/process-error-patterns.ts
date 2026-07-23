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

// Single source of truth for stream-process error codes and their user-facing
// messages (the Task-7 table).
//
//   * `PROCESS_ERROR_MESSAGES` — the code → { message, suppress flag } catalog.
//     The cerastream engine reports STRUCTURED error codes over IPC;
//     `cerastream-error-mapping.ts` resolves them against this catalog, so no
//     stderr scraping exists on the engine path.
//   * `PROCESS_ERROR_PATTERNS` — stderr regexes for srtla_send, the one
//     supervised C process whose only signal is free-form stderr text. Keep ALL
//     srtla stderr regexes here; start-stream.ts must not match stderr inline.

/** Stable, typed error codes shared by the srtla table and the engine mapping. */
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
export type ProcessSource = "srtla";

export interface ProcessErrorMessageEntry {
	/**
	 * Static user-facing message. `srt_connect_failed` is absent on purpose: its
	 * message folds in a runtime reason, built by the engine mapping
	 * (cerastream-error-mapping.ts).
	 */
	message?: string;
	/**
	 * When true, the caller must suppress the notification if an srtla error is
	 * already on screen — avoids stacking a redundant engine-side SRT error on
	 * top of the srtla connection error the user is already seeing.
	 */
	suppressIfSrtlaNotified: boolean;
}

/** Code → user message catalog (single source of truth for both tables). */
export const PROCESS_ERROR_MESSAGES: Record<
	ProcessErrorCode,
	ProcessErrorMessageEntry
> = {
	[PROCESS_ERROR_CODES.SRTLA_INITIAL_CONNECT_FAILED]: {
		message:
			"The SRTLA sender exhausted its initial connection attempts and stopped.",
		suppressIfSrtlaNotified: false,
	},
	[PROCESS_ERROR_CODES.SRTLA_NO_CONNECTIONS]: {
		message: "All SRTLA links are down. The sender is reconnecting its links.",
		suppressIfSrtlaNotified: false,
	},
	[PROCESS_ERROR_CODES.CAPTURE_AUDIO_ERROR]: {
		message: "Capture card error (audio). No automatic restart is scheduled.",
		suppressIfSrtlaNotified: false,
	},
	[PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR]: {
		message: "Capture card error (video). No automatic restart is scheduled.",
		suppressIfSrtlaNotified: false,
	},
	[PROCESS_ERROR_CODES.PIPELINE_STALL]: {
		message: "The input source has stalled. No automatic restart is scheduled.",
		suppressIfSrtlaNotified: false,
	},
	[PROCESS_ERROR_CODES.SRT_CONNECT_FAILED]: {
		// Dynamic message (runtime reason folded in by the engine mapping).
		suppressIfSrtlaNotified: true,
	},
	[PROCESS_ERROR_CODES.SRT_CONNECTION_LOST]: {
		message: "The SRT connection failed. No automatic reconnect is scheduled.",
		suppressIfSrtlaNotified: true,
	},
};

export interface ProcessErrorPattern {
	/** Typed code (shared with the structured engine mapping). */
	code: ProcessErrorCode;
	/** Process whose stderr this row matches. */
	source: ProcessSource;
	/** stderr matcher. The ONLY place these regexes are allowed to live. */
	pattern: RegExp;
}

export interface ResolvedProcessError {
	code: ProcessErrorCode;
	message: string;
	suppressIfSrtlaNotified: boolean;
}

/**
 * Ordered stderr-pattern table for srtla_send. Matched top-to-bottom; the first
 * hit wins.
 */
export const PROCESS_ERROR_PATTERNS: ReadonlyArray<ProcessErrorPattern> = [
	{
		code: PROCESS_ERROR_CODES.SRTLA_INITIAL_CONNECT_FAILED,
		source: "srtla",
		pattern: /Failed to establish any initial connections/,
	},
	{
		code: PROCESS_ERROR_CODES.SRTLA_NO_CONNECTIONS,
		source: "srtla",
		pattern: /no available connections/,
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
		const catalog = PROCESS_ERROR_MESSAGES[entry.code];
		if (catalog.message === undefined) continue;
		return {
			code: entry.code,
			message: catalog.message,
			suppressIfSrtlaNotified: catalog.suppressIfSrtlaNotified,
		};
	}
	return undefined;
}
