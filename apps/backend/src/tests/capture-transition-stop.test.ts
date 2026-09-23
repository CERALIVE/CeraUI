import { expect, test } from "bun:test";
import {
	INTERNAL_TRANSITION_WORST_CASE_BOUND_MS,
	statusEventSchema,
} from "@ceralive/cerastream";
import {
	ENGINE_TRANSITION_STOP_DEADLINE_MS,
	STOP_DEADLINE_MS,
} from "../modules/streaming/start-lifecycle-timing.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

function harness() {
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let id = 0;
	let stops = 0;
	let finishStop: (() => void) | undefined;
	const orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => "attempt",
		setStreamingStatus: () => {},
		stopRuntime: () => {
			stops += 1;
			return new Promise<void>((resolve) => {
				finishStop = resolve;
			});
		},
		queryRuntime: async () => "idle",
		scheduleTimeout: (callback, delay) => {
			const timer = ++id;
			timers.set(timer, { callback, delay });
			return timer;
		},
		cancelTimeout: (timer) => {
			if (typeof timer === "number") timers.delete(timer);
		},
	});
	return {
		orchestrator,
		timers,
		stops: () => stops,
		finish: () => finishStop?.(),
		fire: (delay: number) => {
			for (const [key, timer] of [...timers])
				if (timer.delay === delay) {
					timers.delete(key);
					timer.callback();
				}
		},
	};
}

async function started(h: ReturnType<typeof harness>) {
	expect(
		(await h.orchestrator.start({ origin: "ui", launch: async () => {} }))
			.result,
	).toBe("started");
}

function status(state: "idle" | "starting" | "streaming", transition?: string) {
	return statusEventSchema.parse({
		type: "status",
		seq: 1,
		state,
		streaming: state === "streaming",
		...(transition === undefined
			? {}
			: {
					active_encode: {
						codec: "h264",
						resolution: "1920x1080",
						framerate: 30,
						capture: {
							state: "degraded",
							live_inputs: ["camera-a"],
							degraded_inputs: [],
							failover_rate_policy: "retime",
							transition: { kind: transition, since_ms: 1 },
						},
					},
				}),
	});
}

test("a_stop_during_an_engine_internal_transition_resolves_stopped_not_stop_failed", async () => {
	const h = harness();
	await started(h);
	h.orchestrator.noteEngineStatus(status("streaming", "suspend"));
	const stop = h.orchestrator.stop("operator");
	expect(h.stops()).toBe(0);
	expect(
		[...h.timers.values()].some(
			(timer) => timer.delay === ENGINE_TRANSITION_STOP_DEADLINE_MS,
		),
	).toBe(true);
	h.fire(STOP_DEADLINE_MS);
	expect(h.stops()).toBe(0);
	h.orchestrator.noteEngineStatus(
		statusEventSchema.parse({
			...status("streaming", "suspend"),
			active_encode: {
				codec: "h264",
				resolution: "1920x1080",
				framerate: 30,
				capture: {
					state: "normal",
					live_inputs: ["camera-a"],
					degraded_inputs: [],
					failover_rate_policy: "retime",
				},
			},
		}),
	);
	expect(h.stops()).toBe(1);
	h.finish();
	expect(await stop).toEqual({ result: "stopped" });
});

test("the_engine_transition_latch_survives_frames_without_active_encode_and_clears_on_idle_or_deadline", async () => {
	const h = harness();
	await started(h);
	h.orchestrator.noteEngineStatus(status("streaming", "resume"));
	h.orchestrator.noteEngineStatus(status("starting"));
	const stop = h.orchestrator.stop("operator");
	expect(h.stops()).toBe(0);
	h.orchestrator.noteEngineStatus(status("idle"));
	expect(await stop).toEqual({ result: "stopped" });
	expect(h.stops()).toBe(0);

	const h2 = harness();
	await started(h2);
	h2.orchestrator.noteEngineStatus(status("streaming", "adapt"));
	const stop2 = h2.orchestrator.stop("operator");
	h2.fire(INTERNAL_TRANSITION_WORST_CASE_BOUND_MS);
	expect(h2.stops()).toBe(1);
	h2.finish();
	expect(await stop2).toEqual({ result: "stopped" });
});
