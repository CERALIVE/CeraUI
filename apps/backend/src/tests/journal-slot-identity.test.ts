import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModemMutationEntry } from "@ceraui/rpc/schemas";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import {
	listMutationEntries,
	listUnreadableSlots,
	MutationJournalInventoryError,
	mutationSlotName,
	readMutationEntry,
} from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { tryAcquireModemMutation } from "../modules/streaming/lifecycle-admission.ts";
import {
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
	seedFailedMutation,
	useJournalReconciliationHarness,
} from "./helpers/journal-reconciliation-harness.ts";

// The harness binds the streaming-liveness leaf for this file (useSessionOwnerForFile).
const harness = useJournalReconciliationHarness();

const slotPath = (key: string): string =>
	join(harness.root(), `${mutationSlotName(key)}.json`);
const sha256 = (path: string): string =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

function recordFor(
	stableKey: string,
	state: ModemMutationEntry["state"],
): string {
	const entry: ModemMutationEntry = {
		version: 1,
		stableKey,
		kind: "usb-mode",
		state,
		attemptId: "misfiled",
		startedAt: 1,
		updatedAt: 1,
		preState: {},
		history: [{ state, at: 1 }],
	};
	return `${JSON.stringify(entry)}\n`;
}

test("acknowledging a slot whose record names another key keeps that key's executing evidence", async () => {
	// Given B holds its mutation lease after durably journaling executing.
	const executing = deferred();
	const hold = deferred();
	const mutation = withJournaledModemMutation(
		"usb:b",
		"usb-mode",
		{},
		async (journal) => {
			await journal.markExecuting();
			executing.release();
			await hold.promise;
			return { confirmed: false, value: "b" };
		},
	);
	await executing.promise;
	// And A's slot holds a schema-valid acknowledged record that names B.
	writeFileSync(slotPath("usb:a"), recordFor("usb:b", "acknowledged"));
	const bBefore = sha256(slotPath("usb:b"));
	const aBefore = sha256(slotPath("usb:a"));
	resetRecoveryBarrier();
	try {
		// When an ordinary acknowledgement retry requests A.
		const answer = await acknowledgeMutation("usb:a", "verified-rollback");
		// Then both records survive byte-identically and the existing vocabulary answers.
		expect(existsSync(slotPath("usb:b"))).toBe(true);
		expect(sha256(slotPath("usb:b"))).toBe(bBefore);
		expect(sha256(slotPath("usb:a"))).toBe(aBefore);
		expect(answer).toEqual({ success: false, error: "no_entry" });
		expect(isRecoveryPending()).toBe(true);
		expect(tryAcquireModemMutation("usb:a").admitted).toBe(false);
	} finally {
		hold.release();
		await mutation.catch(() => undefined);
	}
	expect(await mutation).toEqual({ ok: true, value: "b" });
	expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
});

test("a direct read of a misfiled slot is a read fault, never the other key's record", async () => {
	// Given A's slot carries a record naming B.
	writeFileSync(slotPath("usb:a"), recordFor("usb:b", "failed"));
	// When the record is read for A.
	const entry = await readMutationEntry("usb:a");
	// Then nothing is returned and recovery is raised rather than absence assumed.
	expect(entry).toBeUndefined();
	expect(isRecoveryPending()).toBe(true);
});

test("an inventory names misfiled slots as damaged and still lists the healthy key", async () => {
	// Given one healthy record and two misfiled records claiming the same key.
	await seedFailedMutation("usb:a");
	const strayHashed = `${mutationSlotName("usb:c")}.json`;
	writeFileSync(
		join(harness.root(), strayHashed),
		recordFor("usb:b", "failed"),
	);
	writeFileSync(
		join(harness.root(), "stray.json"),
		recordFor("usb:b", "failed"),
	);
	// When the inventory is read.
	const unreadable = await listUnreadableSlots();
	const listed = await listMutationEntries();
	// Then both misfiled names are damaged and only the bound record is an entry.
	expect([...unreadable].sort()).toEqual([strayHashed, "stray.json"].sort());
	expect(listed.map((entry) => entry.stableKey)).toEqual(["usb:a"]);
	expect(isRecoveryPending()).toBe(true);
});

test("a complete inventory refuses a misfiled slot", async () => {
	// Given only a misfiled record.
	const stray = `${mutationSlotName("usb:c")}.json`;
	writeFileSync(join(harness.root(), stray), recordFor("usb:b", "executing"));
	// When the complete inventory is demanded, then it throws the inventory error naming it.
	const result = listMutationEntries(undefined, true);
	await expect(result).rejects.toBeInstanceOf(MutationJournalInventoryError);
	await expect(result).rejects.toMatchObject({ slot: stray });
});

// A misfiled record must take exactly the path a torn record already takes.
const damage = {
	torn: () => "{",
	misfiled: () => recordFor("usb:b", "executing"),
} as const;

for (const [layout, bytes] of Object.entries(damage)) {
	test(`startup recovery neither replays nor deletes a ${layout} slot and stays blocked`, async () => {
		// Given A's slot is damaged, and a held retry clock.
		writeFileSync(slotPath("usb:a"), bytes());
		const before = sha256(slotPath("usb:a"));
		const clock = new JournalRetryClock();
		// When startup recovery runs.
		const summary = await initMutationRecovery({ sleep: clock.sleep });
		// Then the slot and the strict publication are both incomplete, nothing is re-filed or deleted.
		expect(summary).toEqual({
			rolledBack: 0,
			pruned: 0,
			blocked: 0,
			quarantined: 0,
			unreadable: 2,
		});
		expect(sha256(slotPath("usb:a"))).toBe(before);
		expect(existsSync(slotPath("usb:b"))).toBe(false);
		expect(isRecoveryPending()).toBe(true);
		// And a permanent fault keeps the retry owner waiting, not spinning or clearing.
		await clock.at(1);
		clock.advance();
		await clock.at(2);
		expect(sha256(slotPath("usb:a"))).toBe(before);
		expect(isRecoveryPending()).toBe(true);
		expect(tryAcquireModemMutation("usb:b").admitted).toBe(false);
	});

	test(`a correctly filed record beside a ${layout} slot retires as it always has`, async () => {
		// Given a bound failed record for A and a damaged slot for another hash.
		await seedFailedMutation("usb:a");
		const damaged = join(harness.root(), `${mutationSlotName("usb:c")}.json`);
		writeFileSync(damaged, bytes());
		const before = sha256(damaged);
		// When A is acknowledged against matching hardware.
		const answer = acknowledgeMutation("usb:a", "verified-rollback");
		// Then A's slot retires, and the strict block publication refuses the damaged inventory.
		await expect(answer).rejects.toBeInstanceOf(MutationJournalInventoryError);
		expect(existsSync(slotPath("usb:a"))).toBe(false);
		expect(sha256(damaged)).toBe(before);
	});
}
