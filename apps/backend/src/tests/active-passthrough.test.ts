import { afterEach, describe, expect, test } from "bun:test";

import {
	getActivePassthrough,
	readPassthroughFromEvent,
	readStreamingFalse,
	resetActivePassthrough,
} from "../modules/streaming/active-passthrough.ts";

afterEach(() => resetActivePassthrough());

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
