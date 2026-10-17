import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	mutationSlotName,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { stopMutationRecovery } from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	resetLifecycleInterlock,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "journal-verification-"));
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	setMutationJournalDeps({ dir: root });
	setMutationBlockDeps({
		presentStableKeys: async () => new Set(["usb:retained"]),
	});
});
afterEach(() => {
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	resetMutationJournalDeps();
	resetMutationBlockDeps();
	rmSync(root, { recursive: true, force: true });
});
function entry(): string {
	return JSON.stringify({
		version: 1,
		stableKey: "usb:retained",
		kind: "usb-mode",
		state: "executing",
		attemptId: "retained",
		startedAt: 1,
		updatedAt: 1,
		preState: {},
		history: [{ state: "executing", at: 1 }],
	});
}

test("journal verification cannot clear damage discovered by its block-publication pass", async () => {
	// Given healthy startup and a runtime executing entry, with a controlled retry clock.
	let release: () => void = () => {};
	let secondWait: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		secondWait = resolve;
	});
	let waits = 0;
	await initMutationRecovery({
		sleep: async () => {
			waits++;
			if (waits === 2) secondWait();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	const path = join(root, `${mutationSlotName("usb:retained")}.json`);
	writeFileSync(path, entry());
	let reads = 0;
	setMutationJournalDeps({
		dir: root,
		fs: {
			...defaultMutationJournalFs,
			readText: async (p) => {
				reads++;
				if (reads === 2) writeFileSync(path, "{");
				return defaultMutationJournalFs.readText(p);
			},
		},
	});
	// When the second pass discovers newer malformed authority.
	beginRecoveryBarrier();
	release();
	await Promise.race([reached, awaitRecoveryBarrier()]);
	// Then damage remains held; retry is still owned and no modem mutation is admitted.
	expect(reads).toBe(2);
	expect(readFileSync(path, "utf8")).toBe("{");
	expect(isRecoveryPending()).toBe(true);
	expect(tryAcquireModemMutation("usb:retained").admitted).toBe(false);
	stopMutationRecovery();
	release();
});

test("shutdown disarms journal retry scheduling even when a later read raises the barrier", async () => {
	// Given an initialized retry owner with no active flight.
	const waits: number[] = [];
	await initMutationRecovery({
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
	// When shutdown stops recovery, and a late callback raises a new barrier.
	stopMutationRecovery();
	completeRecoveryBarrier();
	beginRecoveryBarrier();
	await Promise.resolve();
	// Then the late raise does not start another timer or verification flight.
	expect(waits).toEqual([]);
	expect(isRecoveryPending()).toBe(true);
});
