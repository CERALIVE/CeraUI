import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	mutationSlotName,
	readMutationEntry,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	streamingBlockingMutation,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	JournalRetryClock,
	seedFailedMutation,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	invalidateReplayRead,
	observeReplaySummaries,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const harness = useReplayHarness();
for (const trigger of ["acknowledgement", "read-fault"] as const) {
	test(`${trigger} during rollback capture retains replay and unblocks without restart`, async () => {
		// Given real boot residue and a slow first capture of B.
		if (trigger === "acknowledgement") await seedFailedMutation();
		await seedInterruptedMutation();
		const path = join(harness.root(), `${mutationSlotName("usb:b")}.json`);
		const bytes = readFileSync(path);
		const capture = harness.pauseRollback();
		const clock = new JournalRetryClock();
		const summaries = observeReplaySummaries();
		try {
			const init = initMutationRecovery({ sleep: clock.sleep });
			await capture.entered;
			let lowered = 0;
			const done = awaitRecoveryBarrier().then(() => {
				lowered++;
			});
			// When an operator's A acknowledgement or a real read fault invalidates B.
			if (trigger === "acknowledgement") {
				expect(await acknowledgeMutation("usb:a", "verified-rollback")).toEqual(
					{ success: true, state: "acknowledged" },
				);
			} else {
				await invalidateReplayRead(harness.root());
			}
			capture.release();
			const summary = await init;
			expect(summary.unreadable).toBe(1);
			expect(summary.rolledBack).toBe(0);
			expect(readFileSync(path)).toEqual(bytes);
			expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
			expect(isRecoveryPending()).toBe(true);
			expect(lowered).toBe(0);
			expect(clock.waits).toEqual([1000]);
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
			// Then the automatic REPLAY retry retires B, never just verifies its block.
			clock.advance();
			await Promise.race([done, clock.at(2)]);
			expect(summaries.values().slice(1)).toEqual([
				{
					rolledBack: 1,
					pruned: 0,
					blocked: 0,
					quarantined: 0,
					unreadable: 0,
					module: "modems",
				},
			]);
			expect(readdirSync(harness.root())).toEqual([]);
			expect(currentMutationBlocks()).toEqual([]);
			expect(streamingBlockingMutation()).toBeUndefined();
			expect(isRecoveryPending()).toBe(false);
			expect(lowered).toBe(1);
			expect(clock.waits).toEqual([1000]);
			const admission = tryAcquireModemMutation("usb:b");
			expect(admission.admitted).toBe(true);
			if (admission.admitted) admission.lease.release();
		} finally {
			capture.release();
			summaries.restore();
		}
	});
}

test("a replay-mode retry invalidated again remains replay until its next complete pass", async () => {
	// Given boot replay invalidated once with the real slot still executing.
	await seedInterruptedMutation();
	const clock = new JournalRetryClock();
	const first = harness.pauseRollback();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await first.entered;
	await invalidateReplayRead(harness.root());
	first.release();
	expect((await init).unreadable).toBe(1);
	const done = awaitRecoveryBarrier();
	const second = harness.pauseRollback();
	// When the replay owner's next capture is invalidated too.
	clock.advance();
	await second.entered;
	await invalidateReplayRead(harness.root());
	second.release();
	await Promise.race([clock.at(2), done]);
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000, 2000]);
	expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	// Then a later fresh replay, not read-only verification, removes the slot.
	clock.advance();
	await Promise.race([done, clock.at(3)]);
	expect(readdirSync(harness.root())).toEqual([]);
	expect(currentMutationBlocks()).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
	expect(clock.waits).toEqual([1000, 2000]);
});

test("same-entry acknowledgement during capture survives the fresh replay retry", async () => {
	// Given a captured executing B; an operator sees a newer failed B before capture returns.
	await seedInterruptedMutation();
	const capture = harness.pauseRollback();
	const clock = new JournalRetryClock();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await capture.entered;
	await seedFailedMutation("usb:b");
	expect(await acknowledgeMutation("usb:b", "verified-rollback")).toEqual({
		success: true,
		state: "acknowledged",
	});
	// When the old replay resumes, that removal invalidates its captured authority.
	capture.release();
	expect((await init).unreadable).toBe(1);
	expect(readdirSync(harness.root())).toEqual([]);
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	// Then no retained B object resurrects a slot or submits another capture/rollback.
	expect(capture.captures()).toBe(2);
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	expect(currentMutationBlocks()).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
});
