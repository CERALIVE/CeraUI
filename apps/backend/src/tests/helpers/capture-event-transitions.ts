import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStatusSchema } from "@ceralive/cerastream";
import { captureSourceSchema, type DeviceEvent } from "@ceraui/rpc/schemas";
import {
	type emitEvent,
	resetEventEmitterForTest,
	setEventSink,
} from "../../modules/events/emit.ts";
import { appendEvent, readEvents } from "../../modules/events/store.ts";
import {
	noteCaptureStatus,
	setCaptureResilienceDepsForTest,
} from "../../modules/streaming/capture-resilience.ts";
import {
	reportActiveVideoSource,
	setLifecycleIndicatorDepsForTest,
} from "../../modules/streaming/lifecycle-indicators.ts";

const sources = ["A", "B", "C"].map((id) =>
	captureSourceSchema.parse({
		id,
		displayName: `Camera ${id}`,
		origin: "capture",
		kind: "hdmi",
		devicePath: `/dev/${id}`,
		pipelineId: "hdmi",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "none",
		available: true,
	}),
);

export function captureTransitions(mode: "recording" | "store") {
	const dir = mkdtempSync(join(tmpdir(), "capture-transitions-"));
	const recorded: { code: string; params: object }[] = [];
	const notices: string[] = [];
	let catalog = sources;
	let now = 10_000;
	let observer: (code: string) => void = () => undefined;
	const record: typeof emitEvent = (code, params) => {
		recorded.push({ code, params });
		observer(code);
	};
	resetEventEmitterForTest({
		now: () => now,
		tailSeq: () => 0,
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir: dir }),
		log: () => undefined,
	});
	if (mode === "store") setEventSink((event) => observer(event.code));
	setLifecycleIndicatorDepsForTest({
		notify: (name) => notices.push(name),
		removeNotification: () => ({ remove: [] }),
		...(mode === "recording" ? { emitEvent: record } : {}),
	});
	setCaptureResilienceDepsForTest({
		sources: () => catalog,
		now: () => now,
		notify: (name) => notices.push(name),
		removeNotification: () => undefined,
		setTimer: () => 1,
		clearTimer: () => undefined,
		...(mode === "recording" ? { emitEvent: record } : {}),
	});
	return {
		notices,
		onEvent: (next: (code: string) => void) => {
			observer = next;
		},
		events: (): readonly { code: string; params: object }[] =>
			mode === "recording"
				? recorded
				: readEvents({ baseDir: dir }).map((event: DeviceEvent) => ({
						code: event.code,
						params: event.params,
					})),
		catalog: (present: boolean) => {
			catalog = present ? sources : [];
		},
		capture: (live: string[], degraded: string[] = [], state = "degraded") => {
			now += 31_000;
			noteCaptureStatus(
				captureStatusSchema.parse({
					state,
					live_inputs: live,
					degraded_inputs: degraded.map((input_id) => ({ input_id })),
					failover_rate_policy: "retime",
				}),
				true,
			);
		},
		explicitCapture: (p: {
			readonly live: readonly string[];
			readonly degraded: readonly string[];
			readonly active: string;
		}) => {
			now += 31_000;
			noteCaptureStatus(
				captureStatusSchema.parse({
					state: p.degraded.length === 0 ? "normal" : "degraded",
					live_inputs: p.live,
					degraded_inputs: p.degraded.map((input_id) => ({ input_id })),
					active_source: {
						input_id: p.active,
						width: 1920,
						height: 1080,
						framerate: 30,
						retimed: false,
						rescaled: false,
					},
					failover_rate_policy: "retime",
				}),
				true,
			);
		},
		partial: () => noteCaptureStatus(undefined, true),
		video: (presentSourceIds: string[], activeSourceId = "A") => {
			now += 31_000;
			reportActiveVideoSource({
				isStreaming: true,
				activeSourceId,
				presentSourceIds,
			});
		},
		stop: () => {
			noteCaptureStatus(undefined, false);
			reportActiveVideoSource({
				isStreaming: false,
				activeSourceId: "A",
				presentSourceIds: [],
			});
		},
		close: () => {
			setCaptureResilienceDepsForTest(null);
			setLifecycleIndicatorDepsForTest(null);
			resetEventEmitterForTest();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
