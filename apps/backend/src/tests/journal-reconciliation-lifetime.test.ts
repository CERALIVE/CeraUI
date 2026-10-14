import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
	currentMutationBlocks,
	refreshMutationBlocks,
} from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	removeMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { stopMutationRecovery } from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import * as admission from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	JournalRetryClock,
	seedFailedMutation,
	useJournalReconciliationHarness,
} from "./helpers/journal-reconciliation-harness.ts";

const harness = useJournalReconciliationHarness();
test("an empty captured inventory from an in-flight write cannot lower blocks", async () => {
	// Given a retained block and a real new commit held before its rename.
	await seedFailedMutation();
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	await removeMutationEntry("usb:a");
	let release = () => {};
	let entered = () => {};
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			rename: async (from, to) => {
				entered();
				await hold;
				await defaultMutationJournalFs.rename(from, to);
			},
		},
	});
	const writer = seedFailedMutation("usb:b");
	await reached;
	try {
		// When enumeration finds no final slot while that writer still owns settlement.
		await expect(refreshMutationBlocks()).rejects.toThrow(
			"mutation journal changed during reconciliation",
		);
		// Then empty is not permission to erase the retained projection.
		expect(currentMutationBlocks()).toEqual([
			{
				stableKey: "usb:a",
				kind: "usb-mode",
				state: "failed",
				updatedAt: 1,
				devicePresent: true,
				blocksStreaming: true,
			},
		]);
		expect(isRecoveryPending()).toBe(true);
	} finally {
		release();
		await writer;
	}
});
test("a commit after block publication cannot lower admission using the older successful verification", async () => {
	// Given a completed real startup and the production verifier waiting to publish.
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	beginRecoveryBarrier();
	const done = awaitRecoveryBarrier();
	const setBlocks = admission.setMutationBlocks;
	let writer: Promise<void> | undefined;
	const publication = spyOn(admission, "setMutationBlocks").mockImplementation(
		(blocks) => {
			setBlocks(blocks);
			if (!writer) writer = seedFailedMutation("usb:b");
		},
	);
	try {
		// When a new real write begins after publication but before awaited completion.
		clock.advance();
		await Promise.race([clock.at(2), done]);
		// Then completion requires a new proof; the next pass publishes the final revision.
		expect(isRecoveryPending()).toBe(true);
		expect(clock.waits).toEqual([1000, 2000]);
		await writer;
		publication.mockRestore();
		clock.advance();
		await done;
		expect(
			currentMutationBlocks()
				.map((b) => b.stableKey)
				.sort(),
		).toEqual(["usb:a", "usb:b"]);
		expect(isRecoveryPending()).toBe(false);
	} finally {
		publication.mockRestore();
		await writer;
	}
});

test("two raises during one pass are remembered without starting a second retry owner", async () => {
	// Given a live read-only pass with no journal changes.
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	beginRecoveryBarrier();
	const done = awaitRecoveryBarrier();
	const presence = harness.pausePresence();
	clock.advance();
	await presence.entered;
	// When two independent triggers arrive during the same held enumeration.
	beginRecoveryBarrier();
	beginRecoveryBarrier();
	presence.release();
	await Promise.race([clock.at(2), done]);
	// Then one fresh pass consumes the remembered raises and resolves once.
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000, 2000]);
	clock.advance();
	await done;
	expect(clock.waits).toEqual([1000, 2000]);
	expect(isRecoveryPending()).toBe(false);
});

test("repeated invalidation backs off to the ceiling, and shutdown retains admission", async () => {
	// Given a real journal and a verifier invalidated on each held presence read.
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	beginRecoveryBarrier();
	const done = awaitRecoveryBarrier();
	// When eight successive passes encounter a newer cooperating commit.
	for (let n = 1; n <= 8; n++) {
		const presence = harness.pausePresence();
		clock.advance();
		await presence.entered;
		await seedFailedMutation("usb:b");
		presence.release();
		await Promise.race([clock.at(n + 1), done]);
		expect(isRecoveryPending()).toBe(true);
	}
	// Then invalidation never spins and a stopped owner never lowers the barrier.
	expect(clock.waits).toEqual([
		1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
	]);
	stopMutationRecovery();
	clock.advance();
	await Promise.resolve();
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toHaveLength(9);
	await initMutationRecovery({ sleep: clock.sleep });
	expect(isRecoveryPending()).toBe(false);
	expect(
		currentMutationBlocks()
			.map((b) => b.stableKey)
			.sort(),
	).toEqual(["usb:a", "usb:b"]);
});

test("permanent enumeration failure cancels its capped owner on shutdown", async () => {
	// Given healthy startup and a permanently failing real anchored census port.
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const fault = spyOn(fs, "readdir").mockRejectedValue(
		Object.assign(new Error("EIO permanent"), { code: "EIO" }),
	);
	try {
		await expect(
			defaultMutationJournalFs.listDir(harness.root()),
		).rejects.toThrow("EIO permanent");
		// When each wait is released, followed by shutdown of the sleeping owner.
		for (let n = 2; n <= 9; n++) {
			clock.advance();
			await clock.at(n);
		}
		expect(clock.waits).toEqual([
			1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
		]);
		stopMutationRecovery();
		clock.advance();
		await Promise.resolve();
		// Then there are no more passes and admission stays closed, never timed out open.
		expect(fault).toHaveBeenCalledTimes(9);
		expect(isRecoveryPending()).toBe(true);
		expect(clock.waits).toHaveLength(9);
	} finally {
		fault.mockRestore();
	}
});

test("an empty captured inventory cannot clear a block committed while its read was pending", async () => {
	// Given a real empty startup and a held census that captured the old names.
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	let held = false;
	let release = () => {};
	let entered = () => {};
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			listDir: async (dir) => {
				const names = await defaultMutationJournalFs.listDir(dir);
				if (!held) {
					held = true;
					entered();
					await hold;
				}
				return names;
			},
		},
	});
	try {
		const old = refreshMutationBlocks();
		await reached;
		// When a real failed commit and fresh publication overtake that empty snapshot.
		await seedFailedMutation();
		await refreshMutationBlocks();
		release();
		await old.catch(() => undefined);
		// Then the old empty snapshot cannot clear the new restrictive projection.
		expect(currentMutationBlocks()).toEqual([
			{
				stableKey: "usb:a",
				kind: "usb-mode",
				state: "failed",
				updatedAt: 1,
				devicePresent: true,
				blocksStreaming: true,
			},
		]);
	} finally {
		release();
	}
});
