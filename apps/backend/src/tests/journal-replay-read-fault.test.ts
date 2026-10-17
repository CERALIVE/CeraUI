import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { stopMutationRecovery } from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
	seedFailedMutation,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	invalidateReplayRead,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const harness = useReplayHarness();
test("a fault in the fresh per-slot read cannot become a terminal blocked entry", async () => {
	// Given a real slot readable in both inventories but failing in its action read.
	await seedInterruptedMutation();
	let reads = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				if (++reads === 3) {
					await invalidateReplayRead(harness.root());
					throw Object.assign(new Error("EIO action read"), { code: "EIO" });
				}
				return defaultMutationJournalFs.readText(path);
			},
		},
	});
	const clock = new JournalRetryClock();
	// When replay catches that read fault, final publication cannot erase the obligation.
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	// Then a replay retry, not a verification verdict, settles the interrupted slot.
	expect(readdirSync(harness.root())).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
	expect(currentMutationBlocks()).toEqual([]);
});

test("an invalidated absent action read retries rather than silently skipping newer executing authority", async () => {
	// Given a listed B whose action read is paused after capturing absence.
	await seedInterruptedMutation();
	const entered = deferred();
	const hold = deferred();
	let reads = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				if (++reads === 3) {
					entered.release();
					await hold.promise;
					return undefined;
				}
				return defaultMutationJournalFs.readText(path);
			},
		},
	});
	const clock = new JournalRetryClock();
	try {
		const init = initMutationRecovery({ sleep: clock.sleep });
		await entered.promise;
		// When a newer cooperating commit overtakes that stale absence.
		await seedInterruptedMutation();
		hold.release();
		expect((await init).unreadable).toBe(1);
		const done = awaitRecoveryBarrier();
		clock.advance();
		await Promise.race([done, clock.at(2)]);
		// Then the new real entry is replayed; absence never becomes a completed pass.
		expect(readdirSync(harness.root())).toEqual([]);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		hold.release();
	}
});

test("retry rereads an operator-retired same slot and fences an older captured executing record", async () => {
	// Given incomplete boot and a retry action read held after reading real bytes.
	await seedInterruptedMutation();
	const capture = harness.pauseRollback();
	const clock = new JournalRetryClock();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await capture.entered;
	await invalidateReplayRead(harness.root());
	capture.release();
	expect((await init).unreadable).toBe(1);
	const entered = deferred();
	const hold = deferred();
	let reads = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				const bytes = await defaultMutationJournalFs.readText(path);
				if (++reads === 3) {
					entered.release();
					await hold.promise;
				}
				return bytes;
			},
		},
	});
	try {
		const done = awaitRecoveryBarrier();
		clock.advance();
		await entered.promise;
		// When the same entry becomes failed and is acknowledged while old bytes wait.
		await seedFailedMutation("usb:b");
		expect(await acknowledgeMutation("usb:b", "verified-rollback")).toEqual({
			success: true,
			state: "acknowledged",
		});
		hold.release();
		await Promise.race([clock.at(2), done]);
		expect(isRecoveryPending()).toBe(true);
		expect(capture.captures()).toBe(2);
		clock.advance();
		await Promise.race([done, clock.at(3)]);
		// Then old captured bytes cannot dispatch rollback or resurrect the retired slot.
		expect(capture.captures()).toBe(2);
		expect(readdirSync(harness.root())).toEqual([]);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		hold.release();
	}
});

test("permanent action-read faults keep replay owned with capped waits and shutdown cancellation", async () => {
	// Given valid inventory bytes and a permanent fault at each third action read.
	await seedInterruptedMutation();
	let reads = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				if (++reads % 4 === 3) {
					await invalidateReplayRead(harness.root());
					throw new Error("EIO permanent action read");
				}
				return defaultMutationJournalFs.readText(path);
			},
		},
	});
	const clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	// When storage never supplies a complete pass, each next wait remains owned.
	for (let n = 2; n <= 9; n++) {
		clock.advance();
		await clock.at(n);
	}
	expect(clock.waits).toEqual([
		1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
	]);
	expect(reads).toBe(36);
	stopMutationRecovery();
	clock.advance();
	await Promise.resolve();
	// Then no busy loop, false completion or further read follows cancellation.
	expect(reads).toBe(36);
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toHaveLength(9);
});
