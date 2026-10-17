import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	readMutationEntry,
	removeMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";
import {
	journalBytes,
	journalFiles,
} from "./helpers/journal-retirement-harness.ts";

const harness = useReplayHarness();
test("ENOENT from a cooperating deletion still fsyncs and succeeds without retry", async () => {
	// Given a slot removed by a cooperating writer at the real unlink boundary.
	await seedInterruptedMutation();
	const calls: string[] = [];
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			unlink: async (path) => {
				calls.push("unlink");
				await unlink(path);
				await defaultMutationJournalFs.unlink(path);
			},
			fsyncDir: async (dir) => {
				calls.push("fsync");
				await defaultMutationJournalFs.fsyncDir(dir);
			},
		},
	});
	const clock = new JournalRetryClock();
	// When the actual replay calls removal, genuine ENOENT is absence, not EIO.
	expect(await initMutationRecovery({ sleep: clock.sleep })).toEqual({
		rolledBack: 1,
		pruned: 0,
		blocked: 0,
		quarantined: 0,
		unreadable: 0,
	});
	// Then the parent acknowledgement is still required and no timer is needed.
	expect(calls).toEqual(["unlink", "fsync"]);
	expect(journalFiles(harness.root())).toEqual([]);
	expect(clock.waits).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
});

test("two racing removals both acknowledge absence without resurrecting authority", async () => {
	// Given the same actual slot and two submitted deletions.
	await seedInterruptedMutation();
	let syncs = 0;
	const deps = {
		dir: harness.root(),
		now: () => 2,
		fs: {
			...defaultMutationJournalFs,
			fsyncDir: async (dir: string) => {
				syncs++;
				await defaultMutationJournalFs.fsyncDir(dir);
			},
		},
	};
	// When one unlink wins and one receives real ENOENT.
	await Promise.all([
		removeMutationEntry("usb:b", deps),
		removeMutationEntry("usb:b", deps),
	]);
	// Then both contracts acknowledge directory durability, not a fabricated entry.
	expect(syncs).toBe(2);
	expect(journalFiles(harness.root())).toEqual([]);
});

for (const errno of ["EIO", "EACCES", "ENOSPC", "ENOTDIR"]) {
	test(`${errno} removal preserves exact executing bytes and rejects`, async () => {
		// Given a non-absence filesystem error at the real journal deletion port.
		await seedInterruptedMutation();
		const bytes = journalBytes(harness.root());
		const error = Object.assign(new Error(`unlink ${errno}`), { code: errno });
		let syncs = 0;
		// When unlink fails, parent fsync cannot manufacture retirement success.
		await expect(
			removeMutationEntry("usb:b", {
				dir: harness.root(),
				now: () => 2,
				fs: {
					...defaultMutationJournalFs,
					unlink: async () => {
						throw error;
					},
					fsyncDir: async () => {
						syncs++;
					},
				},
			}),
		).rejects.toBe(error);
		// Then the unchanged slot remains authority, with no acknowledgement attempt.
		expect(journalBytes(harness.root())).toEqual(bytes);
		expect(syncs).toBe(0);
	});
}

test("visible unlink with permanent parent fsync EIO stays incomplete until acknowledgement succeeds", async () => {
	// Given a successful unlink followed by failed parent acknowledgement.
	await seedInterruptedMutation();
	let healthy = false;
	let unlinks = 0;
	let syncs = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			unlink: async (path) => {
				unlinks++;
				await defaultMutationJournalFs.unlink(path);
			},
			fsyncDir: async (dir) => {
				syncs++;
				if (!healthy)
					throw Object.assign(new Error("parent EIO"), { code: "EIO" });
				await defaultMutationJournalFs.fsyncDir(dir);
			},
		},
	});
	const clock = new JournalRetryClock();
	// When readable absence cannot acknowledge the failed directory sync.
	expect((await initMutationRecovery({ sleep: clock.sleep })).rolledBack).toBe(
		0,
	);
	expect(journalFiles(harness.root())).toEqual([]);
	expect(isRecoveryPending()).toBe(true);
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	// Then empty readback never substitutes for fsync; repair completes the same owner.
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000, 2000]);
	expect(unlinks).toBe(1);
	expect(syncs).toBe(2);
	healthy = true;
	clock.advance();
	await Promise.race([done, clock.at(3)]);
	expect(isRecoveryPending()).toBe(false);
	expect(unlinks).toBe(1);
	expect(syncs).toBe(3);
	expect(journalFiles(harness.root())).toEqual([]);
});

test("pending parent acknowledgement cannot delete a newer slot across recovery lifetimes", async () => {
	// Given visible deletion with failed parent sync and a newer cooperating decision.
	await seedInterruptedMutation();
	const previous = await readMutationEntry("usb:b");
	if (!previous) throw new Error("missing seeded entry");
	let healthy = false;
	let unlinks = 0;
	const fs = {
		...defaultMutationJournalFs,
		unlink: async (path: string) => {
			unlinks++;
			await defaultMutationJournalFs.unlink(path);
		},
		fsyncDir: async (dir: string) => {
			if (!healthy)
				throw Object.assign(new Error("parent pending"), { code: "EIO" });
			await defaultMutationJournalFs.fsyncDir(dir);
		},
	};
	setMutationJournalDeps({ dir: harness.root(), fs });
	const clock = new JournalRetryClock();
	expect((await initMutationRecovery({ sleep: clock.sleep })).unreadable).toBe(
		1,
	);
	await commitMutationEntry(
		{ ...previous, state: "failed", attemptId: "newer" },
		{ dir: harness.root(), fs: defaultMutationJournalFs, now: () => 3 },
	);
	const bytes = journalBytes(harness.root());
	// When a fresh recovery lifetime acknowledges only the retained parent sync.
	healthy = true;
	expect(await initMutationRecovery({ sleep: clock.sleep })).toEqual({
		rolledBack: 0,
		pruned: 0,
		blocked: 1,
		quarantined: 0,
		unreadable: 0,
	});
	// Then the old deletion is never resubmitted against newer authoritative bytes.
	expect(journalBytes(harness.root())).toEqual(bytes);
	expect((await readMutationEntry("usb:b"))?.attemptId).toBe("newer");
	expect(unlinks).toBe(1);
	expect(isRecoveryPending()).toBe(false);
});

test("an older successful directory sync cannot discard a newer failed acknowledgement", async () => {
	// Given two racing removals, with the older parent sync held and newer sync failing.
	await seedInterruptedMutation();
	const entered = deferred();
	const hold = deferred();
	let healthy = false;
	let syncs = 0;
	const fs = {
		...defaultMutationJournalFs,
		fsyncDir: async (dir: string) => {
			if (++syncs === 1) {
				entered.release();
				await hold.promise;
			} else if (!healthy)
				throw Object.assign(new Error("newer parent EIO"), { code: "EIO" });
			await defaultMutationJournalFs.fsyncDir(dir);
		},
	};
	setMutationJournalDeps({ dir: harness.root(), fs });
	const older = removeMutationEntry("usb:b");
	try {
		await entered.promise;
		await expect(removeMutationEntry("usb:b")).rejects.toThrow(
			"newer parent EIO",
		);
		// When the older successful acknowledgement finishes after the newer failure.
		hold.release();
		await older;
		const clock = new JournalRetryClock();
		expect(
			(await initMutationRecovery({ sleep: clock.sleep })).unreadable,
		).toBe(1);
		// Then the newer acknowledgement remains owed, and repair clears only that debt.
		expect(syncs).toBe(3);
		expect(isRecoveryPending()).toBe(true);
		healthy = true;
		const done = awaitRecoveryBarrier();
		clock.advance();
		await Promise.race([done, clock.at(2)]);
		expect(syncs).toBe(4);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		hold.release();
		await older;
	}
});
