import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	refreshMutationBlocks,
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	listUnreadableSlots,
	mutationSlotName,
	removeMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import {
	resetLifecycleInterlock,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "journal-delete-"));
	resetRecoveryBarrier();
	completeRecoveryBarrier();
	resetLifecycleInterlock();
	setMutationJournalDeps({ dir: root });
	setMutationBlockDeps({
		presentStableKeys: async () => new Set(["usb:a", "usb:b"]),
	});
});
afterEach(() => {
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	resetMutationJournalDeps();
	resetMutationBlockDeps();
	rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	for (const stableKey of ["usb:a", "usb:b"])
		await commitMutationEntry({
			version: 1,
			stableKey,
			kind: "usb-mode",
			state: "failed",
			attemptId: "retained",
			startedAt: 1,
			updatedAt: 1,
			preState: {},
			history: [{ state: "failed", at: 1 }],
		});
	const target = join(root, `${mutationSlotName("usb:b")}.json`);
	let deleted = false;
	setMutationJournalDeps({
		dir: root,
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				if (path === target && !deleted) {
					deleted = true;
					await removeMutationEntry("usb:b");
				}
				return defaultMutationJournalFs.readText(path);
			},
		},
	});
	return target;
}

test("a concurrent durable journal deletion does not veto block publication", async () => {
	// Given two failed-state slots and a delete after listing but before reading b.
	await fixture();
	// When the production publisher consumes that inventory.
	const blocks = await refreshMutationBlocks();
	// Then only a stays blocked; healthy-device admission has no recovery barrier.
	expect(blocks.map((block) => block.stableKey)).toEqual(["usb:a"]);
	expect(isRecoveryPending()).toBe(false);
	const admitted = tryAcquireModemMutation("usb:b");
	expect(admitted.admitted).toBe(true);
	if (admitted.admitted) admitted.lease.release();
});

test("a concurrent deletion is not an unreadable slot in the verification pass", async () => {
	// Given the same real-file concurrent delete in verification's first inventory.
	await fixture();
	// When verification inventories unreadable entries.
	const unreadable = await listUnreadableSlots();
	// Then it records no damage and cannot cause a false barrier retry.
	expect(unreadable).toEqual([]);
	expect(isRecoveryPending()).toBe(false);
});

test("a genuinely malformed journal entry still vetoes strict publication", async () => {
	// Given valid slots, then damage in b rather than absence.
	const target = await fixture();
	setMutationJournalDeps({ dir: root });
	writeFileSync(target, "{");
	// When publication parses the malformed entry.
	await expect(refreshMutationBlocks()).rejects.toThrow(
		"unreadable mutation journal inventory",
	);
	// Then retained damage keeps the recovery barrier closed.
	expect(readFileSync(target, "utf8")).toBe("{");
	expect(isRecoveryPending()).toBe(true);
	expect(tryAcquireModemMutation("usb:unrelated").admitted).toBe(false);
});
