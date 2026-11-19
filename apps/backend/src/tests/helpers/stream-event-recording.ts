import { spyOn } from "bun:test";
import type { EventCode } from "@ceraui/rpc/events";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import * as events from "../../modules/events/emit.ts";
import * as armed from "../../modules/streaming/armed-stream-marker.ts";
import { stopEngineReconnect } from "../../modules/streaming/engine-reconnect.ts";
import { resetLifecycleIndicatorState } from "../../modules/streaming/lifecycle-indicators.ts";
import { getStreamLifecycleState } from "../../modules/streaming/stream-lifecycle-status.ts";
import {
	createStreamSessionOrchestrator,
	type StreamLaunchContext,
	type StreamSessionOrchestratorDeps,
} from "../../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps as production } from "../../modules/streaming/stream-session-production.ts";
import * as streaming from "../../modules/streaming/streaming.ts";
import type { EngineRuntimeState } from "../../modules/streaming/streaming-backend.ts";
import * as notices from "../../modules/ui/notifications.ts";

export function clearedEventTimer(): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => undefined, 100_000);
	clearTimeout(timer);
	return timer;
}

export function eventRecording(
	fault?: EventCode | "all",
	overrides: Partial<StreamSessionOrchestratorDeps> = {},
) {
	stopEngineReconnect();
	resetLifecycleIndicatorState();
	streaming.updateStatus(false);
	let now = 10_000;
	let runtime: EngineRuntimeState = "idle";
	const trace: string[] = [];
	const notifications: unknown[][] = [];
	const attempts: { code: EventCode; params: unknown }[] = [];
	const stored: DeviceEvent[] = [];
	const expiry: (() => void)[] = [];
	const restores: (() => void)[] = [];
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const notify = spyOn(notices, "notificationBroadcast").mockImplementation(
		(...args) => {
			notifications.push(["notify", ...args]);
		},
	);
	const remove = spyOn(notices, "notificationRemove").mockImplementation(
		(...args) => {
			notifications.push(["remove", ...args]);
			return { remove: [] };
		},
	);
	const marker = spyOn(armed, "noteStreamStopped").mockImplementation(
		(cause) => {
			trace.push(`marker:${cause}`);
		},
	);
	events.resetEventEmitterForTest({
		bootId: () => "11111111111111111111111111111111",
		tailSeq: () => 0,
		now: () => now,
		appendEvent: (event) => {
			stored.push(event);
		},
		log: () => undefined,
		warn: () => undefined,
		schedule: (fn) => {
			expiry.push(fn);
			return { unref: () => undefined, cancel: () => undefined };
		},
	});
	const original = events.emitEvent;
	const emit = spyOn(events, "emitEvent").mockImplementation((code, params) => {
		attempts.push({ code, params });
		if (fault === "all" || fault === code)
			throw new Error("injected emitter failure");
		original(code, params);
	});
	restores.push(
		() => clock.mockRestore(),
		() => notify.mockRestore(),
		() => remove.mockRestore(),
		() => marker.mockRestore(),
		() => emit.mockRestore(),
	);
	const session = createStreamSessionOrchestrator({
		...production,
		initialLiveness: "idle",
		createAttemptId: () => "containment-attempt",
		getStreamingStatus: streaming.getIsStreaming,
		queryRuntime: async () => runtime,
		admitLifecycle: () => ({
			admitted: true,
			lease: { holder: "streaming", release: () => undefined },
		}),
		awaitRecovery: async () => undefined,
		recoveryPending: () => false,
		blockingMutation: () => undefined,
		admitUpdate: async () => ({ allowed: true }),
		markStreamingForOta: () => true,
		unmarkStreamingForOta: () => true,
		suppressionContext: () => ({
			bootWindow: false,
			engineRestartWindow: false,
			softwareUpdateActive: false,
			cancelledByStop: false,
		}),
		now: () => now,
		scheduleTimeout: (callback, ms) => {
			if (ms <= 1) queueMicrotask(callback);
			return clearedEventTimer();
		},
		cancelTimeout: clearTimeout,
		...overrides,
		setLifecycleState: (state) => {
			trace.push(`life:${state}`);
			production.setLifecycleState?.(state);
		},
		setStreamingStatus: (value) => {
			trace.push(`status:${value}`);
			streaming.updateStatus(value);
		},
		stopRuntime: async (generation, confirm) => {
			trace.push("runtime-stop");
			await overrides.stopRuntime?.(generation, confirm);
		},
		onStreamCommitted: (current) => {
			trace.push(`committed:${current()}`);
		},
		onStreamArmed: (current) => {
			trace.push(`armed:${current()}`);
		},
		onStreamStopped: (cause) => {
			trace.push("stop-hook");
			production.onStreamStopped?.(cause);
		},
		publishConfigChangePhase: (event) => {
			trace.push(`config:${event.phase}`);
		},
	});
	return {
		session,
		trace,
		notifications,
		attempts,
		stored,
		restores,
		start: (
			launch: (context: StreamLaunchContext) => Promise<void> = async () =>
				undefined,
		) =>
			session.start({
				origin: "ui",
				launch: async (context) => {
					trace.push("launch");
					await launch(context);
				},
			}),
		setRuntime: (value: EngineRuntimeState) => {
			runtime = value;
		},
		failureEntries: () =>
			attempts.filter((e) => e.code === "stream_stop_failed"),
		checkpoint: () => ({
			owner: session.snapshot(),
			published: getStreamLifecycleState(),
			streaming: streaming.getIsStreaming(),
		}),
		flush: () => {
			now += 30_000;
			for (const callback of expiry.splice(0)) callback();
		},
		dispose: () => {
			stopEngineReconnect();
			for (const restore of restores.reverse()) restore();
			events.resetEventEmitterForTest();
			resetLifecycleIndicatorState();
			streaming.updateStatus(false);
		},
	};
}
