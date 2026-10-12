import { expect } from "bun:test";
import type { StartResult, StopResult } from "@ceraui/rpc/schemas";
import {
	isLifecycleHeld,
	tryAcquireLifecycle,
} from "../../modules/streaming/lifecycle-admission.ts";
import {
	createStreamSessionOrchestrator,
	type EngineConfigChangeOutcome,
} from "../../modules/streaming/stream-session-orchestrator.ts";
import type { StreamStartUpdateAdmission } from "../../modules/system/update-orchestrator/runtime.ts";

export async function flush(): Promise<void> {
	// Exhaust the bounded continuation chain, without a wall-clock scheduler.
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

export function modelHarness(marker?: {
	readonly mark: () => void;
	readonly unmark: () => void;
}) {
	let id = 0;
	let marked = false;
	let reportedLive = false;
	let engine: "idle" | "streaming" | "unknown" = "idle";
	let launches = 0;
	let outstandingLaunches = 0;
	let stopCalls = 0;
	let stopOutstanding = 0;
	let overlap = false;
	const admissions: ReturnType<
		typeof Promise.withResolvers<StreamStartUpdateAdmission>
	>[] = [];
	const launchGates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
	const stops: ReturnType<typeof Promise.withResolvers<void>>[] = [];
	const changes: ReturnType<
		typeof Promise.withResolvers<EngineConfigChangeOutcome>
	>[] = [];
	const timers = new Map<number, () => void>();
	let timerId = 0;
	const schedule = (callback: () => void) => {
		timers.set(++timerId, callback);
		return timerId;
	};
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => `model-${++id}`,
		setStreamingStatus: (value) => {
			reportedLive = value;
		},
		getStreamingStatus: () => reportedLive,
		markStreamingForOta: () => {
			marked = true;
			marker?.mark();
		},
		unmarkStreamingForOta: () => {
			marked = false;
			marker?.unmark();
		},
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		admitUpdate: () => {
			const gate = Promise.withResolvers<StreamStartUpdateAdmission>();
			admissions.push(gate);
			return gate.promise;
		},
		stopRuntime: () => {
			stopCalls++;
			stopOutstanding++;
			const gate = Promise.withResolvers<void>();
			stops.push(gate);
			return gate.promise.finally(() => {
				stopOutstanding--;
			});
		},
		queryRuntime: async () => engine,
		changeRuntimeConfig: () => {
			const gate = Promise.withResolvers<EngineConfigChangeOutcome>();
			changes.push(gate);
			return gate.promise;
		},
		retryPolicy: {
			maxAttempts: 1,
			totalBudgetMs: 100,
			baseDelayMs: 1,
			maxDelayMs: 1,
			attemptTimeoutMs: 10,
		},
		scheduleTimeout: schedule,
		cancelTimeout: (timer) => {
			if (typeof timer === "number") timers.delete(timer);
		},
		scheduleLaunchDeadline: schedule,
		cancelLaunchDeadline: (timer) => {
			if (typeof timer === "number") timers.delete(timer);
		},
	});
	const results: Promise<StartResult | StopResult | undefined>[] = [];
	const start = () => {
		const call = session.start({
			origin: "ui",
			launch: () => {
				overlap ||= stopOutstanding > 0;
				launches++;
				outstandingLaunches++;
				const gate = Promise.withResolvers<void>();
				launchGates.push(gate);
				engine = "unknown";
				return gate.promise.finally(() => {
					outstandingLaunches--;
				});
			},
		});
		results.push(call.catch(() => undefined));
		return call;
	};
	return {
		session,
		start,
		admissions,
		launchGates,
		stops,
		changes,
		timers,
		results,
		stop: () => {
			const call = session.stop("operator");
			results.push(call);
			return call;
		},
		setEngine: (value: typeof engine) => {
			engine = value;
		},
		view: () => ({
			marked,
			reportedLive,
			engine,
			launches,
			outstandingLaunches,
			stopCalls,
			stopOutstanding,
			overlap,
			held: isLifecycleHeld(),
			...session.snapshot(),
		}),
		assert: () => {
			expect(outstandingLaunches).toBeLessThanOrEqual(1); // I1
			expect(overlap).toBe(false);
		},
	};
}

export async function launchLive(
	h: ReturnType<typeof modelHarness>,
): Promise<void> {
	const call = h.start();
	h.admissions.shift()?.resolve({ allowed: true });
	await flush();
	h.setEngine("streaming");
	h.launchGates.shift()?.resolve();
	expect((await call).result).toBe("started");
}
