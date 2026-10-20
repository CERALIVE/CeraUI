import { afterEach, expect, test } from "bun:test";
import {
	isLifecycleHeld,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	admitAndPrepareStreamStart,
	resetOrchestratorRuntimeForTest,
	type StreamStartUpdateAdmission,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

afterEach(() => {
	resetLifecycleInterlock();
	resetOrchestratorRuntimeForTest();
});

test("Stop cancels a held D8 admission before launch or OTA marking and releases its real lease", async () => {
	// Given real mutual exclusion and a pending allowed admission.
	const admission = Promise.withResolvers<StreamStartUpdateAdmission>();
	const marks: string[] = [];
	let launches = 0;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "held-admission",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		admitUpdate: () => admission.promise,
		markStreamingForOta: () => marks.push("mark"),
		unmarkStreamingForOta: () => marks.push("unmark"),
	});
	const start = session.start({
		origin: "ui",
		launch: async () => {
			launches += 1;
		},
	});
	expect(isLifecycleHeld()).toBe(true);
	// When Stop precedes the admission answer.
	const stop = await session.stop("operator");
	admission.resolve({ allowed: true });
	const result = await start;
	// Then the old generation cannot create media or a later OTA sentinel.
	expect(stop).toEqual({ result: "stopped" });
	expect(result).toEqual({ result: "cancelled", attemptId: "held-admission" });
	expect(launches).toBe(0);
	expect(marks).not.toContain("mark");
	expect(session.snapshot().state).toBe("idle");
	expect(isLifecycleHeld()).toBe(false);
});

test("same-turn Stop cancels the production idle D8 hook without launching", async () => {
	// Given the actual production admission hook with no update active.
	setOrchestratorStateForTest(initialOrchestratorState(0));
	let launches = 0;
	const marks: string[] = [];
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "idle-admission",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		admitUpdate: admitAndPrepareStreamStart,
		markStreamingForOta: () => marks.push("mark"),
	});
	// When Start and Stop arrive in the same turn.
	const start = session.start({
		origin: "ui",
		launch: async () => {
			launches += 1;
		},
	});
	await session.stop("operator");
	const result = await start;
	// Then even an immediately allowed hook cannot resurrect the cancelled start.
	expect(result.result).toBe("cancelled");
	expect(launches).toBe(0);
	expect(marks).toEqual([]);
	expect(isLifecycleHeld()).toBe(false);
});

test("throwing D8 admission unwinds pending state and the real lifecycle lease", async () => {
	// Given a failed admission observer, not a launched engine.
	const failure = new Error("admission-observation-failed");
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "throwing-admission",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		admitUpdate: async () => {
			throw failure;
		},
	});
	// When admission throws.
	await expect(
		session.start({ origin: "ui", launch: async () => {} }),
	).rejects.toBe(failure);
	// Then another lifecycle operation is not stranded.
	expect(session.snapshot().state).toBe("idle");
	expect(isLifecycleHeld()).toBe(false);
});
