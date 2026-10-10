import { expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { OrchestratorRecoveryLoadError } from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateStartupCadence } from "../modules/system/update-orchestrator/startup-cadence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

test("a later authoritative refusal stops the transient cadence without granting startup", async () => {
	// Given six transient failures followed by a safety refusal.
	const c = startupCadenceClock();
	const cadence = new UpdateStartupCadence();
	let calls = 0;
	const work = async () => {
		calls++;
		throw new OsStageError(
			calls <= 6 ? "os_update_lock_held" : "rauc_recovery_unproven",
		);
	};
	await expect(cadence.start(work, c.clock)).rejects.toBeInstanceOf(
		OsStageError,
	);
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	// When the later attempt observes authoritative refusal.
	await timer.work();
	// Then the first-reader barrier settles refused, with no new retry.
	expect(calls).toBe(7);
	expect(c.timers).toHaveLength(1);
	expect(await cadence.waitForAdjudication()).toBe(false);
});

test("invalid recovery load errors never retry even with an underlying cause", async () => {
	// Given the typed invalid-present metadata error at the retry boundary.
	const c = startupCadenceClock();
	const cadence = new UpdateStartupCadence();
	const error = new OrchestratorRecoveryLoadError(initialOrchestratorState(0));
	error.cause = new Error("invalid schema is not transient I/O");
	let calls = 0;
	// When startup encounters it.
	await expect(
		cadence.start(async () => {
			calls++;
			throw error;
		}, c.clock),
	).rejects.toBe(error);
	// Then neither the burst nor the later cadence can clear invalid metadata.
	expect(calls).toBe(1);
	expect(c.delays).toEqual([]);
	expect(c.timers).toEqual([]);
	expect(await cadence.waitForAdjudication()).toBe(false);
});

test("a caused safety error retries as transient I/O and succeeds on the later cadence", async () => {
	// Given a typed refusal carrying the transient physical-probe I/O cause.
	const c = startupCadenceClock();
	const cadence = new UpdateStartupCadence();
	let calls = 0;
	const work = async () => {
		if (++calls <= 6)
			throw new OsStageError("rauc_recovery_unproven", {
				cause: new Error("probe I/O"),
			});
	};
	await expect(cadence.start(work, c.clock)).rejects.toBeInstanceOf(
		OsStageError,
	);
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	// When the probe becomes readable on a later attempt.
	await timer.work();
	// Then caused refusals retain the existing retry classification.
	expect(await cadence.waitForAdjudication()).toBe(true);
	expect(calls).toBe(7);
});

test("startup callers cannot run a second flight while the background attempt is pending", async () => {
	// Given a background attempt held in real asynchronous work after exhaustion.
	const c = startupCadenceClock();
	const cadence = new UpdateStartupCadence();
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let calls = 0;
	const work = async () => {
		if (++calls <= 6) throw new OsStageError("os_update_lock_held");
		entered.resolve();
		await release.promise;
	};
	const initial = cadence.start(work, c.clock);
	await expect(initial).rejects.toBeInstanceOf(OsStageError);
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	const pending = timer.work();
	await entered.promise;
	// When a second startup caller arrives during the pending attempt.
	expect(cadence.start(work, c.clock)).toBe(initial);
	// Then the caller cannot rearm work or a timer; only the owned attempt settles.
	expect(calls).toBe(7);
	expect(c.timers).toHaveLength(1);
	release.resolve();
	await pending;
	expect(await cadence.waitForAdjudication()).toBe(true);
});
