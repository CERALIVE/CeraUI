import { describe, expect, test } from "bun:test";

import { CerastreamConnectionError } from "@ceralive/cerastream";
import type { StartFailurePhase } from "@ceraui/rpc/schemas";
import {
	createLaunchTransaction,
	type LaunchDeadlineTimers,
} from "../modules/streaming/launch-transaction.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import { START_PHASE_DEADLINES_MS } from "../modules/streaming/start-lifecycle-timing.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function deferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

function fakeTimers(): {
	readonly timers: LaunchDeadlineTimers;
	readonly fire: () => void;
	readonly delay: () => number | undefined;
} {
	let callback: (() => void) | undefined;
	let delayMs: number | undefined;
	return {
		timers: {
			schedule: (next: () => void, delay: number) => {
				callback = next;
				delayMs = delay;
				return 1;
			},
			cancel: () => {},
		},
		fire: () => callback?.(),
		delay: () => delayMs,
	};
}

describe("transactional stream launch", () => {
	test("connect refusal after sender spawn rolls every owned resource back", async () => {
		const resources = {
			sender: false,
			telemetry: false,
			client: false,
			subscription: false,
		};
		const transaction = createLaunchTransaction("attempt-1");
		transaction.register(() => {
			resources.sender = false;
		});
		resources.sender = true;
		transaction.register(() => {
			resources.telemetry = false;
		});
		resources.telemetry = true;
		transaction.register(() => {
			resources.client = false;
		});
		resources.client = true;
		transaction.register(() => {
			resources.subscription = false;
		});
		resources.subscription = true;

		try {
			await transaction.runPhase("connect", async () => {
				throw new CerastreamConnectionError("refused", undefined, "refused");
			});
		} catch (error) {
			expect(error).toBeInstanceOf(StreamStartFailure);
			if (error instanceof StreamStartFailure) {
				expect(error.failure).toMatchObject({
					attemptId: "attempt-1",
					phase: "connect",
					class: "engine_unavailable",
				});
			}
		}
		await transaction.rollback();

		expect(resources).toEqual({
			sender: false,
			telemetry: false,
			client: false,
			subscription: false,
		});
	});

	for (const phase of [
		"connect",
		"hello",
		"subscribe",
		"start-rpc",
		"playing-wait",
	] as const satisfies readonly StartFailurePhase[]) {
		test(`${phase} hang times out and rolls back in reverse order`, async () => {
			const clock = fakeTimers();
			const cleanupOrder: string[] = [];
			const transaction = createLaunchTransaction("attempt-timeout", {
				timers: clock.timers,
			});
			transaction.register(() => {
				cleanupOrder.push("sender");
			});
			transaction.register(() => {
				cleanupOrder.push("telemetry");
			});
			transaction.register(() => {
				cleanupOrder.push("client");
			});
			const hanging = deferred();

			const result = transaction.runPhase(phase, () => hanging.promise);
			expect(clock.delay()).toBe(START_PHASE_DEADLINES_MS[phase]);
			clock.fire();
			await expect(result).rejects.toMatchObject({
				failure: {
					attemptId: "attempt-timeout",
					phase,
					class: "start_timeout",
				},
			});
			await transaction.rollback();
			await transaction.rollback();
			let staleResource = true;
			transaction.register(() => {
				staleResource = false;
			});
			await Promise.resolve();

			expect(cleanupOrder).toEqual(["client", "telemetry", "sender"]);
			expect(staleResource).toBe(false);
		});
	}
});
