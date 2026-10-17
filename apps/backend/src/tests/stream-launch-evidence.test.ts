import { expect, test } from "bun:test";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { confirmUnownedEngineStop } from "../modules/streaming/streamloop/stop-evidence.ts";

for (const certainty of ["idle", "unknown"] as const) {
	test(`retry requires independent rollback certainty=${certainty}`, async () => {
		// Given a retriable failure and independently supplied rollback evidence.
		let dispatches = 0;
		let marked = false;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "retry-evidence",
			setStreamingStatus: () => undefined,
			stopRuntime: async () => undefined,
			queryRuntime: async () => "unknown",
			markStreamingForOta: () => {
				marked = true;
			},
			unmarkStreamingForOta: () => {
				marked = false;
			},
			scheduleTimeout: (callback) => {
				queueMicrotask(callback);
				return 1;
			},
			cancelTimeout: () => undefined,
			retryPolicy: {
				maxAttempts: 2,
				totalBudgetMs: 60000,
				baseDelayMs: 1,
				maxDelayMs: 1,
			},
		});
		// When a retriable connect error carries confirmed or unconfirmed cleanup.
		await session.start({
			origin: "ui",
			launch: async () => {
				dispatches++;
				throw new StreamStartFailure(
					{
						attemptId: "retry-evidence",
						phase: "connect",
						class: "engine_unavailable",
						code: "original_failure",
						retriable: true,
					},
					certainty,
				);
			},
		});
		// Then only positive idle evidence permits another launch and clearance.
		expect(dispatches).toBe(certainty === "idle" ? 2 : 1);
		expect(session.snapshot().state).toBe(
			certainty === "idle" ? "idle" : "reconciling",
		);
		expect(marked).toBe(certainty === "unknown");
	});
}

for (const operator of [true, false]) {
	test(`the unowned Stop adapter permits confirmation only for operator=${operator}`, async () => {
		// Given an unknown engine and a distinct explicit Stop acknowledgement.
		let stops = 0;
		const answer = Promise.withResolvers<boolean>();
		// When the real adapter receives an automatic or operator request.
		confirmUnownedEngineStop(
			async (outcome) => {
				answer.resolve(outcome.ok);
			},
			{
				query: async () => "unknown",
				stop: () => false,
				confirmStop: async () => {
					stops++;
				},
			},
			operator,
		);
		// Then silence alone never grants idle or triggers an automatic Stop.
		expect(await answer.promise).toBe(operator);
		expect(stops).toBe(operator ? 1 : 0);
	});
}
