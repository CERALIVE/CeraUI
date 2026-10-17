import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { readMutationEntry } from "../modules/modems/mutation-journal.ts";
import { stopMutationRecovery } from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	registerMutationRollback,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
	seedFailedMutation,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	invalidateReplayRead,
	replayHardware,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const harness = useReplayHarness();
test("a continuously committing writer gets capped replay waits, then repair clears without restart", async () => {
	// Given startup capture invalidated by another cooperating modem writer.
	await seedInterruptedMutation();
	const clock = new JournalRetryClock();
	const first = harness.pauseRollback();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await first.entered;
	await seedFailedMutation();
	first.release();
	expect((await init).unreadable).toBe(1);
	const done = awaitRecoveryBarrier();
	// When every next replay capture races another real commit and two raises.
	for (let n = 1; n <= 8; n++) {
		const capture = harness.pauseRollback();
		clock.advance();
		await capture.entered;
		await seedFailedMutation();
		beginRecoveryBarrier();
		beginRecoveryBarrier();
		capture.release();
		await Promise.race([clock.at(n + 1), done]);
		expect(isRecoveryPending()).toBe(true);
		expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	}
	// Then the sole owner never spins or times out open; the first clean pass clears.
	expect(clock.waits).toEqual([
		1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
	]);
	clock.advance();
	await Promise.race([done, clock.at(10)]);
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	expect(isRecoveryPending()).toBe(false);
	expect(currentMutationBlocks().map((entry) => entry.stableKey)).toEqual([
		"usb:a",
	]);
});

test("shutdown cancels the replay retry and a new recovery lifetime rereads retained boot residue", async () => {
	// Given an incomplete startup with its retry sleeping, not running unowned.
	await seedInterruptedMutation();
	const clock = new JournalRetryClock();
	const capture = harness.pauseRollback();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await capture.entered;
	await invalidateReplayRead(harness.root());
	capture.release();
	expect((await init).unreadable).toBe(1);
	// When shutdown aborts that flight, retained residue must remain recoverable.
	stopMutationRecovery();
	clock.advance();
	await Promise.resolve();
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000]);
	expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	// Then the new owner reads the real slot and safely completes the same rollback.
	expect(await initMutationRecovery({ sleep: clock.sleep })).toEqual({
		rolledBack: 1,
		pruned: 0,
		blocked: 0,
		quarantined: 0,
		unreadable: 0,
	});
	expect(readdirSync(harness.root())).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
});

test("rollback restored before its fence failed is not submitted twice", async () => {
	// Given a real executing slot and hardware needing a restore.
	await seedInterruptedMutation();
	let productId = "0802";
	let effects = 0;
	const entered = deferred();
	const hold = deferred();
	setMutationCaptureDeps({
		enumerate: async () => [replayHardware("usb:b", productId)],
	});
	registerMutationRollback("usb-mode", {
		rollback: async () => {
			effects++;
			if (productId === "0801") return "failed";
			productId = "0801";
			entered.release();
			await hold.promise;
			return "restored";
		},
	});
	const clock = new JournalRetryClock();
	try {
		const init = initMutationRecovery({ sleep: clock.sleep });
		await entered.promise;
		// When hardware restored but another journal read invalidates settlement.
		await invalidateReplayRead(harness.root());
		hold.release();
		expect((await init).unreadable).toBe(1);
		expect(effects).toBe(1);
		expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
		const done = awaitRecoveryBarrier();
		clock.advance();
		await Promise.race([done, clock.at(2)]);
		// Then fresh hardware read short-circuits the already-restored pre-state.
		expect(effects).toBe(1);
		expect(productId).toBe("0801");
		expect(readdirSync(harness.root())).toEqual([]);
		expect(currentMutationBlocks()).toEqual([]);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		hold.release();
	}
});
