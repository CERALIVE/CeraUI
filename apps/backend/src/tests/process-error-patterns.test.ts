import { describe, expect, test } from "bun:test";

import { resolveCerastreamError } from "../modules/streaming/cerastream-error-mapping.ts";
import {
	PROCESS_ERROR_CODES,
	PROCESS_ERROR_MESSAGES,
	type ProcessSource,
	resolveProcessError,
} from "../modules/streaming/streamloop/process-error-patterns.ts";

describe("srtla stderr pattern table lookup", () => {
	const cases: Array<{
		source: ProcessSource;
		stderr: string;
		code: string;
		message: string;
		suppressIfSrtlaNotified: boolean;
	}> = [
		{
			source: "srtla",
			stderr: "srtla_send: Failed to establish any initial connections",
			code: PROCESS_ERROR_CODES.SRTLA_INITIAL_CONNECT_FAILED,
			message: "Failed to connect to the SRTLA server. Retrying...",
			suppressIfSrtlaNotified: false,
		},
		{
			source: "srtla",
			stderr: "srtla_send: no available connections, dropping packet",
			code: PROCESS_ERROR_CODES.SRTLA_NO_CONNECTIONS,
			message: "All SRTLA connections failed. Trying to reconnect...",
			suppressIfSrtlaNotified: false,
		},
	];

	for (const c of cases) {
		test(`${c.code} resolves from ${c.source} stderr`, () => {
			const resolved = resolveProcessError(c.source, c.stderr);
			expect(resolved?.code).toBe(c.code);
			expect(resolved?.message).toBe(c.message);
			expect(resolved?.suppressIfSrtlaNotified).toBe(c.suppressIfSrtlaNotified);
		});
	}

	test("unrecognised stderr resolves to undefined", () => {
		expect(
			resolveProcessError("srtla", "everything is fine, streaming"),
		).toBeUndefined();
		expect(resolveProcessError("srtla", "")).toBeUndefined();
		// Engine-side signals never arrive as srtla stderr — no cross-source match.
		expect(
			resolveProcessError("srtla", "Pipeline stall detected"),
		).toBeUndefined();
	});
});

describe("shared code → message catalog (Task-7 table)", () => {
	test("every known code has a catalog row", () => {
		for (const code of Object.values(PROCESS_ERROR_CODES)) {
			expect(PROCESS_ERROR_MESSAGES[code]).toBeDefined();
		}
	});

	const staticMessages: Array<{ code: string; message: string }> = [
		{
			code: PROCESS_ERROR_CODES.CAPTURE_AUDIO_ERROR,
			message: "Capture card error (audio). Trying to restart...",
		},
		{
			code: PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR,
			message: "Capture card error (video). Trying to restart...",
		},
		{
			code: PROCESS_ERROR_CODES.PIPELINE_STALL,
			message: "The input source has stalled. Trying to restart...",
		},
		{
			code: PROCESS_ERROR_CODES.SRT_CONNECTION_LOST,
			message: "The SRT connection failed. Trying to reconnect...",
		},
	];

	for (const { code, message } of staticMessages) {
		test(`${code} keeps its user-facing message`, () => {
			expect(
				PROCESS_ERROR_MESSAGES[code as keyof typeof PROCESS_ERROR_MESSAGES]
					.message,
			).toBe(message);
		});
	}

	test("SRT-related engine errors carry the srtla-suppression flag", () => {
		expect(
			PROCESS_ERROR_MESSAGES[PROCESS_ERROR_CODES.SRT_CONNECT_FAILED]
				.suppressIfSrtlaNotified,
		).toBe(true);
		expect(
			PROCESS_ERROR_MESSAGES[PROCESS_ERROR_CODES.SRT_CONNECTION_LOST]
				.suppressIfSrtlaNotified,
		).toBe(true);
		expect(
			PROCESS_ERROR_MESSAGES[PROCESS_ERROR_CODES.PIPELINE_STALL]
				.suppressIfSrtlaNotified,
		).toBe(false);
	});
});

describe("SRT connect failure — dynamic reason message (structured path)", () => {
	test("surfaces the structured reason in parentheses", () => {
		const resolved = resolveCerastreamError(
			"srt_connect_failed",
			"engine",
			"connection refused",
		);
		expect(resolved.code).toBe(PROCESS_ERROR_CODES.SRT_CONNECT_FAILED);
		expect(resolved.message).toBe(
			"Failed to connect to the SRT server (connection refused). Retrying...",
		);
		expect(resolved.suppressIfSrtlaNotified).toBe(true);
	});

	test("omits the parenthetical when no reason is present", () => {
		const resolved = resolveCerastreamError("srt_connect_failed", "engine");
		expect(resolved.message).toBe(
			"Failed to connect to the SRT server. Retrying...",
		);
	});
});
