import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStatusSchema } from "@ceralive/cerastream";
import { captureSourceSchema, type DeviceEvent } from "@ceraui/rpc/schemas";
import {
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendEvent, readEvents, tailSeq } from "../modules/events/store.ts";
import {
	noteCaptureStatus,
	setCaptureResilienceDepsForTest,
} from "../modules/streaming/capture-resilience.ts";
import {
	reportActiveAudioSource,
	reportActiveVideoSource,
	setLifecycleIndicatorDepsForTest,
} from "../modules/streaming/lifecycle-indicators.ts";

test("default producers persist real records and push their trailing recoveries", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "capture-events-"));
	const pushed: DeviceEvent[] = [];
	const timers: (() => void)[] = [];
	let now = 10_000;
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => tailSeq({ baseDir }),
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir }),
		log: () => {},
		schedule: (fn) => {
			timers.push(fn);
			return { cancel: () => {}, unref: () => {} };
		},
	});
	setEventSink((event) => pushed.push(event));
	setLifecycleIndicatorDepsForTest({
		notify: () => {},
		removeNotification: () => ({ remove: [] }),
	});
	setCaptureResilienceDepsForTest({
		sources: () =>
			["A", "B"].map((id) =>
				captureSourceSchema.parse({
					id,
					displayName: `Camera ${id}`,
					origin: "capture",
					kind: "hdmi",
					devicePath: id,
					pipelineId: "hdmi",
					modes: [],
					supportsAudio: false,
					supportsResolutionOverride: true,
					supportsFramerateOverride: true,
					audioKind: "none",
					available: true,
				}),
			),
		now: () => now,
		notify: () => {},
		removeNotification: () => {},
		setTimer: () => 1,
		clearTimer: () => {},
	});
	try {
		for (const presentSourceIds of [["B"], ["A"]])
			reportActiveVideoSource({
				isStreaming: true,
				activeSourceId: "A",
				presentSourceIds,
			});
		for (const isDeviceLost of [true, false])
			reportActiveAudioSource({ isStreaming: true, isDeviceLost });
		for (const fields of [
			{
				state: "degraded",
				live_inputs: ["B"],
				degraded_inputs: [{ input_id: "A" }],
			},
			{ state: "normal", live_inputs: ["B", "A"], degraded_inputs: [] },
			{
				state: "standby",
				live_inputs: [],
				degraded_inputs: [],
				standby_since_ms: 8_000,
			},
			{ state: "normal", live_inputs: ["B"], degraded_inputs: [] },
		])
			noteCaptureStatus(
				captureStatusSchema.parse({
					...fields,
					failover_rate_policy: "retime",
				}),
				true,
			);
		now = 40_000;
		for (const fn of timers) fn();
		const stored = readEvents({ baseDir });
		expect(stored.map((event) => [event.code, event.suppressed])).toEqual([
			["capture_source_lost", undefined],
			["audio_source_lost", undefined],
			["capture_input_lost", undefined],
			["capture_standby_entered", undefined],
			["capture_source_recovered", 1],
			["audio_source_recovered", 1],
			["capture_input_returned", 1],
			["capture_standby_exited", 1],
		]);
		expect(stored).toEqual(pushed);
		expect(stored.every((event) => !("serial" in event.params))).toBe(true);
	} finally {
		setCaptureResilienceDepsForTest(null);
		setLifecycleIndicatorDepsForTest(null);
		resetEventEmitterForTest();
		rmSync(baseDir, { recursive: true, force: true });
	}
});
