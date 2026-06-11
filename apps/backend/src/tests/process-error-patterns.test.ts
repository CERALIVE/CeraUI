import { describe, expect, test } from "bun:test";

import {
	PROCESS_ERROR_CODES,
	type ProcessSource,
	resolveProcessError,
} from "../modules/streaming/streamloop/process-error-patterns.ts";

describe("process error pattern table lookup", () => {
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
		{
			source: "ceracoder",
			stderr: "gstreamer error from alsasrc0: device busy",
			code: PROCESS_ERROR_CODES.CAPTURE_AUDIO_ERROR,
			message: "Capture card error (audio). Trying to restart...",
			suppressIfSrtlaNotified: false,
		},
		{
			source: "ceracoder",
			stderr: "gstreamer error from v4l2src0: no signal",
			code: PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR,
			message: "Capture card error (video). Trying to restart...",
			suppressIfSrtlaNotified: false,
		},
		{
			source: "ceracoder",
			stderr: "Pipeline stall detected after 3000ms",
			code: PROCESS_ERROR_CODES.PIPELINE_STALL,
			message: "The input source has stalled. Trying to restart...",
			suppressIfSrtlaNotified: false,
		},
		{
			source: "ceracoder",
			stderr: "The SRT connection timed out, exiting",
			code: PROCESS_ERROR_CODES.SRT_CONNECTION_LOST,
			message: "The SRT connection failed. Trying to reconnect...",
			suppressIfSrtlaNotified: true,
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

	test("every known code is reachable through the table", () => {
		const reached = new Set(cases.map((c) => c.code));
		// SRT_CONNECT_FAILED is asserted separately (dynamic reason message).
		reached.add(PROCESS_ERROR_CODES.SRT_CONNECT_FAILED);
		for (const code of Object.values(PROCESS_ERROR_CODES)) {
			expect(reached.has(code)).toBe(true);
		}
	});
});

describe("SRT connect failure — dynamic reason extraction", () => {
	test("surfaces the parsed reason in parentheses", () => {
		const resolved = resolveProcessError(
			"ceracoder",
			"Failed to establish an SRT connection: connection refused.",
		);
		expect(resolved?.code).toBe(PROCESS_ERROR_CODES.SRT_CONNECT_FAILED);
		expect(resolved?.message).toBe(
			"Failed to connect to the SRT server (connection refused). Retrying...",
		);
		expect(resolved?.suppressIfSrtlaNotified).toBe(true);
	});

	test("omits the parenthetical when no reason is present", () => {
		const resolved = resolveProcessError(
			"ceracoder",
			"Failed to establish an SRT connection",
		);
		expect(resolved?.message).toBe(
			"Failed to connect to the SRT server. Retrying...",
		);
	});
});

describe("source scoping + non-matches", () => {
	test("a ceracoder pattern does not match under the srtla source", () => {
		expect(
			resolveProcessError("srtla", "Pipeline stall detected"),
		).toBeUndefined();
	});

	test("unrecognised stderr resolves to undefined", () => {
		expect(
			resolveProcessError("ceracoder", "everything is fine, streaming"),
		).toBeUndefined();
		expect(resolveProcessError("srtla", "")).toBeUndefined();
	});
});
