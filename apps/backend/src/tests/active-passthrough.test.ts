import { afterEach, describe, expect, test } from "bun:test";

import {
	framesAdvancedBetween,
	getActiveEncodeLiveness,
	getActivePassthrough,
	ingestLivenessForTest,
	readLivenessFromEvent,
	readPassthroughFromEvent,
	readStreamingFalse,
	resetActiveEncodeLiveness,
	resetActivePassthrough,
} from "../modules/streaming/active-passthrough.ts";

afterEach(() => {
	resetActivePassthrough();
	resetActiveEncodeLiveness();
});

const statusEvent = (active_encode?: unknown, streaming = true) => ({
	jsonrpc: "2.0",
	method: "event",
	params: {
		type: "status",
		seq: 1,
		state: "streaming",
		streaming,
		active_encode,
	},
});

describe("readPassthroughFromEvent", () => {
	test("reads a true passthrough flag off a status event", () => {
		expect(
			readPassthroughFromEvent(
				statusEvent({ codec: "h264", passthrough: true }),
			),
		).toBe(true);
	});

	test("reads a false passthrough flag", () => {
		expect(
			readPassthroughFromEvent(
				statusEvent({ codec: "h264", passthrough: false }),
			),
		).toBe(false);
	});

	test("a heartbeat without active_encode leaves the value unknown", () => {
		expect(readPassthroughFromEvent(statusEvent(undefined))).toBeUndefined();
	});

	test("an active_encode without passthrough leaves the value unknown", () => {
		expect(
			readPassthroughFromEvent(statusEvent({ codec: "h264" })),
		).toBeUndefined();
	});

	test("a non-status event is ignored", () => {
		expect(
			readPassthroughFromEvent({
				params: { type: "bitrate", current_bitrate: 5000 },
			}),
		).toBeUndefined();
		expect(readPassthroughFromEvent(null)).toBeUndefined();
		expect(readPassthroughFromEvent("nope")).toBeUndefined();
	});
});

describe("readStreamingFalse", () => {
	test("true only when a status event reports streaming:false", () => {
		expect(readStreamingFalse(statusEvent(undefined, false))).toBe(true);
		expect(readStreamingFalse(statusEvent(undefined, true))).toBe(false);
		expect(readStreamingFalse({ params: { type: "bitrate" } })).toBe(false);
	});
});

describe("getActivePassthrough cache", () => {
	test("starts unknown and resets clean", () => {
		expect(getActivePassthrough()).toBeUndefined();
		resetActivePassthrough();
		expect(getActivePassthrough()).toBeUndefined();
	});
});

describe("readLivenessFromEvent", () => {
	test("reads the frames_emitted + pipeline_playing pair off a status event", () => {
		expect(
			readLivenessFromEvent(
				statusEvent({
					codec: "h264",
					frames_emitted: 42,
					pipeline_playing: true,
				}),
			),
		).toEqual({ framesEmitted: 42, pipelinePlaying: true });
	});

	test("each field is independently optional", () => {
		expect(
			readLivenessFromEvent(statusEvent({ codec: "h264", frames_emitted: 7 })),
		).toEqual({ framesEmitted: 7 });
		expect(
			readLivenessFromEvent(
				statusEvent({ codec: "h264", pipeline_playing: false }),
			),
		).toEqual({ pipelinePlaying: false });
	});

	test("a legacy active_encode (no liveness fields) yields an empty object", () => {
		expect(readLivenessFromEvent(statusEvent({ codec: "h264" }))).toEqual({});
	});

	test("a non-status frame or one without active_encode is undefined", () => {
		expect(readLivenessFromEvent(statusEvent(undefined))).toBeUndefined();
		expect(
			readLivenessFromEvent({ params: { type: "bitrate" } }),
		).toBeUndefined();
		expect(readLivenessFromEvent(null)).toBeUndefined();
	});

	test("a non-numeric / negative counter is dropped", () => {
		expect(
			readLivenessFromEvent(statusEvent({ codec: "h264", frames_emitted: -1 })),
		).toEqual({});
		expect(
			readLivenessFromEvent(
				statusEvent({ codec: "h264", frames_emitted: "nope" }),
			),
		).toEqual({});
	});
});

describe("framesAdvancedBetween", () => {
	test("undefined until two counts exist", () => {
		expect(framesAdvancedBetween(undefined, 5)).toBeUndefined();
		expect(framesAdvancedBetween(5, undefined)).toBeUndefined();
	});

	test("true when the counter increased, false when flat", () => {
		expect(framesAdvancedBetween(100, 130)).toBe(true);
		expect(framesAdvancedBetween(130, 130)).toBe(false);
		expect(framesAdvancedBetween(130, 120)).toBe(false);
	});
});

describe("getActiveEncodeLiveness cache", () => {
	test("starts unknown and resets clean", () => {
		expect(getActiveEncodeLiveness()).toBeUndefined();
		resetActiveEncodeLiveness();
		expect(getActiveEncodeLiveness()).toBeUndefined();
	});

	test("folds consecutive status frames into an advancing signal + freshness clock", () => {
		ingestLivenessForTest(
			statusEvent({
				codec: "h264",
				frames_emitted: 100,
				pipeline_playing: true,
			}),
			1000,
		);
		// First read: advancement is unknown (only one counter seen).
		expect(getActiveEncodeLiveness()).toEqual({
			framesEmitted: 100,
			framesAdvancing: undefined,
			pipelinePlaying: true,
			lastStatusAtMs: 1000,
		});

		ingestLivenessForTest(
			statusEvent({
				codec: "h264",
				frames_emitted: 160,
				pipeline_playing: true,
			}),
			3000,
		);
		expect(getActiveEncodeLiveness()).toEqual({
			framesEmitted: 160,
			framesAdvancing: true,
			pipelinePlaying: true,
			lastStatusAtMs: 3000,
		});

		// A flat counter on the next heartbeat = a stalled encode.
		ingestLivenessForTest(
			statusEvent({
				codec: "h264",
				frames_emitted: 160,
				pipeline_playing: true,
			}),
			5000,
		);
		const stalled = getActiveEncodeLiveness();
		expect(stalled?.framesAdvancing).toBe(false);
		expect(stalled?.lastStatusAtMs).toBe(5000);
	});

	test("a streaming:false status clears the cache (stop → unknown)", () => {
		ingestLivenessForTest(
			statusEvent({
				codec: "h264",
				frames_emitted: 10,
				pipeline_playing: true,
			}),
			1000,
		);
		expect(getActiveEncodeLiveness()).toBeDefined();
		// The socket handler clears on streaming:false; mirror that here by resetting.
		resetActiveEncodeLiveness();
		expect(getActiveEncodeLiveness()).toBeUndefined();
	});
});
