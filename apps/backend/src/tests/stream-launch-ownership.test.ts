import { expect, test } from "bun:test";
import {
	isLifecycleHeld,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import {
	assertStreamLaunchOwnership,
	currentStreamLaunchOwner,
} from "../modules/streaming/stream-launch-ownership.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

test("cancelled async launch context cannot run a later setup side effect", async () => {
	// Given a real factory launch held across a setup await.
	const gate = Promise.withResolvers<void>();
	let effects = 0;
	let current: (() => boolean) | undefined;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "context",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
	});
	const starting = session.start({
		origin: "remote-control",
		launch: async () => {
			current = currentStreamLaunchOwner();
			await gate.promise;
			assertStreamLaunchOwnership();
			effects++;
		},
	});
	// When Stop invalidates ownership before the setup continuation resumes.
	await session.stop("operator");
	gate.resolve();
	const result = await starting;
	// Then no stale setup mutation runs, including a separately captured callback.
	expect(result.result).toBe("cancelled");
	expect(effects).toBe(0);
	expect(current?.()).toBe(false);
});

test("deferred commit bookkeeping cannot arm a newer generation", async () => {
	// Given a captured production-style bookkeeping predicate from generation one.
	const predicates: (() => boolean)[] = [];
	let id = 0;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => `commit-${++id}`,
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		onStreamArmed: (current) => predicates.push(current),
	});
	await session.start({ origin: "ui", launch: async () => {} });
	// When Stop and a new Start precede the deferred bookkeeping continuation.
	await session.stop("operator");
	await session.start({ origin: "ui", launch: async () => {} });
	// Then only the new generation retains arming authority.
	expect(predicates[0]?.()).toBe(false);
	expect(predicates[1]?.()).toBe(true);
});

test("a synchronous launch rejection still settles the real lifecycle lease", async () => {
	// Given a real admission lease and a rollback-complete launch rejection.
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "sync",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
	});
	// When the dependency throws before returning its promised result.
	const result = await session.start({
		origin: "ui",
		launch: ({ attemptId }) => {
			throw new StreamStartFailure({
				attemptId,
				phase: "params",
				class: "start_invalid",
				retriable: false,
			});
		},
	});
	// Then rejection is typed and neither lifecycle ownership nor starting leaks.
	expect(result).toMatchObject({
		result: "failed",
		failure: { class: "start_invalid" },
	});
	expect(session.snapshot().state).toBe("idle");
	expect(isLifecycleHeld()).toBe(false);
});
