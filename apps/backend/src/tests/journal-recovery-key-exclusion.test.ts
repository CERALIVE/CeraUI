import { expect, test } from "bun:test";
import {
	defaultMutationJournalFs,
	journalNow,
	nextEntry,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import {
	persistMutationFailure,
	resetPendingMutationRemovals,
	settlePendingMutationRemovals,
} from "../modules/modems/mutation-journal-retirement.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	tryAcquireLifecycle,
	tryAcquireModemJournalKey,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import { JournalRetryClock } from "./helpers/journal-reconciliation-harness.ts";
import {
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";
import { journalBytes } from "./helpers/journal-retirement-harness.ts";

const harness = useReplayHarness();

test("replay's fenced removal refuses a held key, keeps the slot and converges after release", async () => {
	// Given boot replay rolling back an interrupted B while an operator retirement holds B's key.
	await seedInterruptedMutation();
	const capture = harness.pauseRollback();
	const clock = new JournalRetryClock();
	const init = initMutationRecovery({ sleep: clock.sleep });
	await capture.entered;
	const holder = tryAcquireModemJournalKey("usb:b");
	if (holder === undefined) throw new Error("fixture key refused");
	const before = journalBytes(harness.root());
	try {
		// When the restored outcome reaches its removal while the key is held.
		capture.release();
		expect((await init).unreadable).toBe(1);
		// Then nothing is deleted, the pass stays incomplete and the barrier holds.
		expect(journalBytes(harness.root())).toEqual(before);
		expect(isRecoveryPending()).toBe(true);
	} finally {
		holder.release();
	}
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	expect(isRecoveryPending()).toBe(false);
});

test("failed-transition settlement waits out a held key without writing, then commits once free", async () => {
	// Given an executing slot whose fallback failed write was retained after an I/O fault.
	await seedInterruptedMutation();
	const executing = await readMutationEntry("usb:b");
	if (executing === undefined) throw new Error("missing seeded slot");
	let faults = 1;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			writeTemp: async (path, data) => {
				if (faults-- > 0)
					throw Object.assign(new Error("EIO"), { code: "EIO" });
				await defaultMutationJournalFs.writeTemp(path, data);
			},
		},
	});
	await persistMutationFailure(
		nextEntry(executing, "failed", journalNow(), "mutation was not dispatched"),
	);
	const before = journalBytes(harness.root());
	const holder = tryAcquireModemJournalKey("usb:b");
	if (holder === undefined) throw new Error("fixture key refused");
	try {
		// When recovery settles while another journal owner holds the key.
		await expect(settlePendingMutationRemovals()).rejects.toThrow(
			"modem mutation journal key is held; recovery retries",
		);
		// Then the slot is untouched and the bookkeeping is retained for the retry.
		expect(journalBytes(harness.root())).toEqual(before);
		holder.release();
		await settlePendingMutationRemovals();
		expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
	} finally {
		holder.release();
		resetPendingMutationRemovals();
	}
});

test("a journal-only key holder excludes the same modem but never refuses a stream start", () => {
	// Given an operator retirement holding B's key.
	const holder = tryAcquireModemJournalKey("usb:b");
	if (holder === undefined) throw new Error("fixture key refused");
	try {
		// When a mutation on B and a stream start are both requested.
		expect(tryAcquireModemMutation("usb:b")).toEqual({
			admitted: false,
			refusal: "mutation_in_progress",
		});
		const stream = tryAcquireLifecycle("streaming");
		// Then only the same-key mutation is refused; streaming keeps its prior admission.
		expect(stream.admitted).toBe(true);
		if (stream.admitted) stream.lease.release();
	} finally {
		holder.release();
	}
});
