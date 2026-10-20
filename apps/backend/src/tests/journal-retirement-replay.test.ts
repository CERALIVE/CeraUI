import { expect, test } from "bun:test";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	readMutationEntry,
} from "../modules/modems/mutation-journal.ts";
import { stopMutationRecovery } from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	streamingBlockingMutation,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import { JournalRetryClock } from "./helpers/journal-reconciliation-harness.ts";
import {
	invalidateReplayRead,
	observeReplaySummaries,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";
import {
	journalBytes,
	journalFiles,
	retirementFault,
} from "./helpers/journal-retirement-harness.ts";

const harness = useReplayHarness();
for (const precedingInvalidation of [false, true]) {
	test(`one unlink EIO retains replay ownership and retires without restart: invalidation=${precedingInvalidation}`, async () => {
		// Given real executing boot residue, already-restored hardware and one unlink EIO.
		await seedInterruptedMutation();
		const bytes = journalBytes(harness.root());
		const fault = retirementFault(harness.root(), 1);
		const clock = new JournalRetryClock();
		const capture = harness.pauseRollback();
		const summaries = observeReplaySummaries();
		try {
			const init = initMutationRecovery({ sleep: clock.sleep });
			await capture.entered;
			let lowered = 0;
			const done = awaitRecoveryBarrier().then(() => {
				lowered++;
			});
			// When startup (or its invalidated replay retry) cannot retire B.
			if (precedingInvalidation) await invalidateReplayRead(harness.root());
			capture.release();
			expect(await init).toEqual({
				rolledBack: 0,
				pruned: 0,
				blocked: 0,
				quarantined: 0,
				unreadable: 1,
			});
			if (precedingInvalidation) {
				clock.advance();
				await Promise.race([clock.at(2), done]);
			}
			expect(fault.unlinks()).toBe(1);
			expect(fault.syncs()).toBe(0);
			expect(journalBytes(harness.root())).toEqual(bytes);
			expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
			expect(isRecoveryPending()).toBe(true);
			expect(lowered).toBe(0);
			expect(currentMutationBlocks()).toEqual([
				{
					stableKey: "usb:b",
					kind: "usb-mode",
					state: "executing",
					updatedAt: 1,
					devicePresent: true,
					blocksStreaming: true,
				},
			]);
			expect(streamingBlockingMutation()).toEqual({
				stableKey: "usb:b",
				refusal: "mutation_in_progress",
				blocksStreaming: true,
			});
			expect(tryAcquireModemMutation("usb:b")).toEqual({
				admitted: false,
				refusal: "recovery_pending",
			});
			expect(await acknowledgeMutation("usb:b", "verified-rollback")).toEqual({
				success: false,
				error: "not_blocked",
			});
			// Then this SAME recovery lifetime really removes B and opens admission once.
			const nextWait = precedingInvalidation ? 3 : 2;
			clock.advance();
			await Promise.race([done, clock.at(nextWait)]);
			expect(summaries.values().slice(-1)).toEqual([
				{
					module: "modems",
					rolledBack: 1,
					pruned: 0,
					blocked: 0,
					quarantined: 0,
					unreadable: 0,
				},
			]);
			expect(fault.unlinks()).toBe(2);
			expect(fault.syncs()).toBe(1);
			expect(journalFiles(harness.root())).toEqual([]);
			expect(currentMutationBlocks()).toEqual([]);
			expect(streamingBlockingMutation()).toBeUndefined();
			expect(isRecoveryPending()).toBe(false);
			expect(lowered).toBe(1);
			expect(clock.waits).toEqual(
				precedingInvalidation ? [1000, 2000] : [1000],
			);
			const admission = tryAcquireModemMutation("usb:b");
			expect(admission.admitted).toBe(true);
			if (admission.admitted) admission.lease.release();
		} finally {
			capture.release();
			summaries.restore();
		}
	});
}

for (const state of ["completed", "acknowledged"] as const) {
	test(`${state} pruning counts progress only after an actual durable retirement`, async () => {
		// Given an archivable real entry and a failed deletion, not a rollback failure.
		await seedInterruptedMutation();
		const entry = await readMutationEntry("usb:b");
		if (!entry) throw new Error("missing seeded entry");
		await commitMutationEntry({ ...entry, state });
		const bytes = journalBytes(harness.root());
		const fault = retirementFault(harness.root(), 1);
		const clock = new JournalRetryClock();
		// When startup attempts the prune/resume-archive step.
		expect(await initMutationRecovery({ sleep: clock.sleep })).toEqual({
			rolledBack: 0,
			pruned: 0,
			blocked: 0,
			quarantined: 0,
			unreadable: 1,
		});
		expect(journalBytes(harness.root())).toEqual(bytes);
		expect(isRecoveryPending()).toBe(true);
		const done = awaitRecoveryBarrier();
		clock.advance();
		await Promise.race([done, clock.at(2)]);
		// Then actual deletion, not the old swallowed result, completes recovery.
		expect(fault.unlinks()).toBe(2);
		expect(journalFiles(harness.root())).toEqual([]);
		expect(isRecoveryPending()).toBe(false);
	});
}

test("permanent unlink EIO keeps one capped cancellable replay flight until storage recovers", async () => {
	// Given permanent EIO with real readable, executing authority.
	await seedInterruptedMutation();
	const bytes = journalBytes(harness.root());
	const fault = retirementFault(harness.root(), Number.POSITIVE_INFINITY);
	const clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	const done = awaitRecoveryBarrier();
	// When eight more attempts cannot delete the entry.
	for (let n = 1; n <= 8; n++) {
		clock.advance();
		await Promise.race([clock.at(n + 1), done]);
		expect(isRecoveryPending()).toBe(true);
		expect(journalBytes(harness.root())).toEqual(bytes);
		expect(fault.unlinks()).toBe(n + 1);
	}
	expect(clock.waits).toEqual([
		1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
	]);
	expect(
		currentMutationBlocks().map((block) => [
			block.state,
			block.blocksStreaming,
		]),
	).toEqual([["executing", true]]);
	expect(await acknowledgeMutation("usb:b", "verified-rollback")).toEqual({
		success: false,
		error: "not_blocked",
	});
	// Then repair lets the same owner complete; shutdown vetoes subsequent work.
	fault.repair();
	clock.advance();
	await Promise.race([done, clock.at(10)]);
	expect(isRecoveryPending()).toBe(false);
	expect(journalFiles(harness.root())).toEqual([]);
	expect(fault.unlinks()).toBe(10);
	stopMutationRecovery();
	clock.advance();
	await Promise.resolve();
	expect(fault.unlinks()).toBe(10);
});

test("shutdown cancels permanent unlink EIO without another retirement attempt", async () => {
	// Given an incomplete actual retirement with its only replay owner waiting.
	await seedInterruptedMutation();
	const bytes = journalBytes(harness.root());
	const fault = retirementFault(harness.root(), Number.POSITIVE_INFINITY);
	const clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	// When shutdown cancels the held backoff, no second unlink may be authorized.
	stopMutationRecovery();
	clock.advance();
	for (let n = 0; n < 10; n++) await Promise.resolve();
	// Then authority stays visible, with no timer, inline spin or barrier clearance.
	expect(fault.unlinks()).toBe(1);
	expect(clock.waits).toEqual([1000]);
	expect(journalBytes(harness.root())).toEqual(bytes);
	expect(isRecoveryPending()).toBe(true);
});
