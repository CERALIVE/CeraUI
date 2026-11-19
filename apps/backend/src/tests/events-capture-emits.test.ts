import { afterEach, beforeEach, expect, test } from "bun:test";
import { captureStatusSchema } from "@ceralive/cerastream";
import type { EventCode } from "@ceraui/rpc/events";
import { captureSourceSchema } from "@ceraui/rpc/schemas";
import {
	type emitEvent,
	resetEventEmitterForTest,
} from "../modules/events/emit.ts";
import {
	noteCaptureStatus,
	setCaptureResilienceDepsForTest,
} from "../modules/streaming/capture-resilience.ts";
import {
	reportActiveAudioSource,
	reportActiveVideoSource,
	setLifecycleIndicatorDepsForTest,
} from "../modules/streaming/lifecycle-indicators.ts";

const events: { code: EventCode; params: object }[] = [];
const record: typeof emitEvent = (code, params) => {
	events.push({ code, params });
};
const sources = ["Camera A", "Camera B", "Camera C"].map((displayName, i) =>
	captureSourceSchema.parse({
		id: `private-serial-${i}`,
		displayName,
		origin: "capture",
		kind: "hdmi",
		devicePath: `/dev/video${i}`,
		pipelineId: "hdmi",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "none",
		available: true,
	}),
);
let now = 10_000;
function status(overrides: Record<string, unknown> = {}) {
	return captureStatusSchema.parse({
		state: "normal",
		live_inputs: ["private-serial-0", "private-serial-1"],
		degraded_inputs: [],
		failover_rate_policy: "retime",
		...overrides,
	});
}
function lost(...ids: number[]) {
	return status({
		state: "degraded",
		live_inputs: ["private-serial-1"],
		degraded_inputs: ids.map((id) => ({ input_id: `private-serial-${id}` })),
	});
}
const standby = () =>
	status({ state: "standby", live_inputs: [], standby_since_ms: 8_000 });
function video(isStreaming: boolean, presentSourceIds: readonly string[]) {
	reportActiveVideoSource({
		isStreaming,
		activeSourceId: "private-serial-0",
		presentSourceIds,
	});
}

beforeEach(() => {
	events.length = 0;
	now = 10_000;
	setLifecycleIndicatorDepsForTest({
		notify: () => {},
		removeNotification: () => ({ remove: [] }),
		emitEvent: record,
	});
	setCaptureResilienceDepsForTest({
		sources: () => sources,
		now: () => now,
		notify: () => {},
		removeNotification: () => {},
		setTimer: () => 1,
		clearTimer: () => {},
		emitEvent: record,
	});
});
afterEach(() => {
	setCaptureResilienceDepsForTest(null);
	setLifecycleIndicatorDepsForTest(null);
	resetEventEmitterForTest();
});

test("active video loss and recovery emit once per existing indicator edge", () => {
	video(true, ["private-serial-0"]);
	video(true, ["private-serial-1"]);
	video(true, ["private-serial-1"]);
	video(true, ["private-serial-0"]);
	video(true, ["private-serial-0"]);
	expect(events).toEqual([
		{ code: "capture_source_lost", params: {} },
		{ code: "capture_source_recovered", params: {} },
	]);
});

test("active audio loss and recovery emit once per existing indicator edge", () => {
	for (const isDeviceLost of [false, true, true, false, false])
		reportActiveAudioSource({ isStreaming: true, isDeviceLost });
	expect(events).toEqual([
		{ code: "audio_source_lost", params: {} },
		{ code: "audio_source_recovered", params: {} },
	]);
});

test("idle and pre-scan reports never claim a capture loss or recovery", () => {
	video(false, ["private-serial-1"]);
	video(true, []);
	reportActiveAudioSource({ isStreaming: false, isDeviceLost: true });
	expect(events).toEqual([]);
});

test("stopping silently clears indicators and permits a later loss edge", () => {
	video(true, ["private-serial-1"]);
	video(false, ["private-serial-0"]);
	video(true, ["private-serial-1"]);
	reportActiveAudioSource({ isStreaming: true, isDeviceLost: true });
	reportActiveAudioSource({ isStreaming: false, isDeviceLost: false });
	expect(events.map((event) => event.code)).toEqual([
		"capture_source_lost",
		"capture_source_lost",
		"audio_source_lost",
	]);
});

test("input loss dedupes and each camera returns independently with product names", () => {
	noteCaptureStatus(lost(0, 2), true);
	noteCaptureStatus(lost(0, 2), true);
	noteCaptureStatus(
		status({
			state: "degraded",
			live_inputs: ["private-serial-1", "private-serial-0"],
			degraded_inputs: [{ input_id: "private-serial-2" }],
		}),
		true,
	);
	noteCaptureStatus(
		status({
			live_inputs: ["private-serial-0", "private-serial-1", "private-serial-2"],
		}),
		true,
	);
	noteCaptureStatus(status(), true);
	expect(events).toEqual([
		{
			code: "capture_input_lost",
			params: { name: "Camera A", activeCamera: false },
		},
		{
			code: "capture_input_lost",
			params: { name: "Camera C", activeCamera: false },
		},
		{
			code: "capture_input_returned",
			params: { name: "Camera A", activeCamera: false },
		},
		{
			code: "capture_input_returned",
			params: { name: "Camera C", activeCamera: false },
		},
	]);
	expect(events.every(({ params }) => !("serial" in params))).toBe(true);
	expect(JSON.stringify(events)).not.toContain("private-serial");
});

test("a returned camera can become the active input", () => {
	noteCaptureStatus(lost(0), true);
	noteCaptureStatus(status(), true);
	expect(events.at(-1)).toEqual({
		code: "capture_input_returned",
		params: { name: "Camera A", activeCamera: true },
	});
});

test("unknown and active degraded input ids do not create input events", () => {
	noteCaptureStatus(lost(1, 9), true);
	expect(events).toEqual([]);
});

test("stream stop clears input notices without claiming they returned", () => {
	noteCaptureStatus(lost(0), true);
	noteCaptureStatus(undefined, false);
	noteCaptureStatus(lost(0), true);
	expect(events.map((event) => event.code)).toEqual([
		"capture_input_lost",
		"capture_input_lost",
	]);
});

test("standby edges report elapsed seconds once and partial frames do not recover", () => {
	noteCaptureStatus(standby(), true);
	noteCaptureStatus(standby(), true);
	noteCaptureStatus(undefined, true);
	now = 12_500;
	noteCaptureStatus(status(), true);
	noteCaptureStatus(status(), true);
	expect(events).toEqual([
		{ code: "capture_standby_entered", params: { durationSec: 2 } },
		{ code: "capture_standby_exited", params: { durationSec: 4.5 } },
	]);
});

test.each([undefined, 20_000])(
	"standby durations stay non-negative for start %s",
	(since) => {
		noteCaptureStatus(
			status({
				state: "standby",
				live_inputs: [],
				...(since === undefined ? {} : { standby_since_ms: since }),
			}),
			true,
		);
		now = 9_000;
		noteCaptureStatus(status(), true);
		expect(events).toEqual([
			{ code: "capture_standby_entered", params: { durationSec: 0 } },
			{ code: "capture_standby_exited", params: { durationSec: 0 } },
		]);
	},
);

test("stream stop does not claim standby recovery and a later entry is fresh", () => {
	noteCaptureStatus(standby(), true);
	noteCaptureStatus(undefined, false);
	noteCaptureStatus(standby(), true);
	expect(events.map((event) => event.code)).toEqual([
		"capture_standby_entered",
		"capture_standby_entered",
	]);
});
