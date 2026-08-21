/**
 * The replay barrier AT THE ADMISSION CHOKEPOINT, and the lease lifetime that
 * spans a deferred transaction.
 *
 * Two refusal semantics are the whole point, and each has its own failure mode if
 * it is got wrong:
 *
 *  - an EXTERNAL arrival refused with `recovery_pending` costs a retry;
 *  - an INTERNAL boot origin refused the same way costs the WHOLE INTENT, because
 *    restoration terminalizes its one-shot marker on an unhandled refusal and
 *    autostart records a failed result with no retry at all.
 *
 * So the internal origins AWAIT, and these tests assert the consequence rather
 * than the mechanism: with replay delayed, each of them launches EXACTLY ONCE
 * afterwards and records NO terminal attempt while it was pending.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LifecycleState, StartResult } from "@ceraui/rpc/schemas";

import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import {
	runStreamRestoration,
	settleStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import { autoStartStream } from "../modules/streaming/streamloop.ts";

async function settleMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function orchestrator(
	overrides: Partial<
		Parameters<typeof createStreamSessionOrchestrator>[0]
	> = {},
) {
	let next = 0;
	return createStreamSessionOrchestrator({
		createAttemptId: () => `attempt-${++next}`,
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		awaitRecovery: awaitRecoveryBarrier,
		recoveryPending: isRecoveryPending,
		...overrides,
	});
}

beforeEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

afterEach(() => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	updateStatus(false);
});

describe("EXTERNAL origins get the typed refusal", () => {
	for (const origin of ["ui", "remote-control", "set-profile"] as const) {
		test(`${origin} arriving during replay is refused recovery_pending, and NEVER launches`, async () => {
			beginRecoveryBarrier();
			let launched = 0;
			const result = await orchestrator().start({
				origin,
				launch: async () => {
					launched += 1;
				},
			});
			expect(result.result).toBe("failed");
			expect(result.result === "failed" && result.failure.class).toBe(
				"recovery_pending",
			);
			expect(result.result === "failed" && result.failure.retriable).toBe(
				false,
			);
			expect(launched).toBe(0);
		});
	}

	test("the SAME UI request succeeds once replay completes", async () => {
		beginRecoveryBarrier();
		const session = orchestrator();
		expect(
			(
				await session.start({
					origin: "ui",
					launch: async () => {},
				})
			).result,
		).toBe("failed");

		completeRecoveryBarrier();
		expect(
			(await session.start({ origin: "ui", launch: async () => {} })).result,
		).toBe("started");
	});
});

describe("INTERNAL origins AWAIT instead of failing", () => {
	for (const origin of ["autostart", "restoration"] as const) {
		test(`${origin} does not settle while replay is pending, then launches ONCE`, async () => {
			beginRecoveryBarrier();
			let launched = 0;
			let settled: StartResult | undefined;
			void orchestrator()
				.start({
					origin,
					launch: async () => {
						launched += 1;
					},
				})
				.then((result) => {
					settled = result;
				});

			await settleMicrotasks();
			expect(launched).toBe(0);
			expect(settled).toBeUndefined();

			completeRecoveryBarrier();
			await settleMicrotasks();
			expect(launched).toBe(1);
			expect(settled?.result).toBe("started");
		});
	}
});

describe("a fail-closed modem blocks GLOBAL stream autostart", () => {
	test("every origin is refused with mutation_blocked while a rollback is unresolved", async () => {
		for (const origin of [
			"ui",
			"autostart",
			"restoration",
			"remote-control",
			"set-profile",
		] as const) {
			const result = await orchestrator({
				blockingMutation: () => ({ stableKey: "usb-0:1.4.1" }),
			}).start({ origin, launch: async () => {} });
			expect(result.result === "failed" && result.failure.class).toBe(
				"mutation_blocked",
			);
		}
	});

	test("with no block, the same start is admitted", async () => {
		const result = await orchestrator({
			blockingMutation: () => undefined,
		}).start({ origin: "ui", launch: async () => {} });
		expect(result.result).toBe("started");
	});
});

describe("restoration judges its one-shot marker only AFTER replay", () => {
	test("a delayed replay records NO terminal attempt while pending", async () => {
		beginRecoveryBarrier();
		let read = 0;
		const attempts: unknown[] = [];
		const run = runStreamRestoration({
			awaitRecovery: awaitRecoveryBarrier,
			marker: {
				markerPath: "/tmp/ceraui-admission-marker-does-not-exist.json",
				readMarker: () => {
					read += 1;
					return undefined;
				},
				writeMarker: (_path: string, contents: string) =>
					attempts.push(contents),
				removeMarker: () => attempts.push("cleared"),
				readBootId: () => "boot-1",
			} as never,
			runtimeState: async () => "idle",
			lifecycleState: (): LifecycleState => "idle",
			launch: async () => ({ ok: true }),
			publish: () => {},
			wait: async () => {},
			now: () => 0,
			logger: { info: () => {}, warn: () => {} },
			pollIntervalMs: 1,
			unknownDeadlineMs: 10,
		});

		await settleMicrotasks();
		// The marker has not even been READ, so nothing about it can have been
		// terminalized by a race with the recovery it depends on.
		expect(read).toBe(0);
		expect(attempts).toEqual([]);

		completeRecoveryBarrier();
		await run;
		await settleStreamRestoration();
		expect(read).toBeGreaterThan(0);
	});
});

describe("boot autostart runs only after replay completes", () => {
	test("autoStartStream awaits the barrier before doing anything", async () => {
		// A live stream makes the body a no-op the instant it is reached, so what
		// this measures is purely WHEN the function gets past its first await.
		updateStatus(true);
		expect(getIsStreaming()).toBe(true);

		beginRecoveryBarrier();
		let done = false;
		const run = autoStartStream().then(() => {
			done = true;
		});
		await settleMicrotasks();
		expect(done).toBe(false);

		completeRecoveryBarrier();
		await run;
		expect(done).toBe(true);
	});
});
