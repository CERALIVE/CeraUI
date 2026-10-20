import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { modemMutationEntrySchema } from "@ceraui/rpc/schemas";
import {
	acknowledgeMutation,
	decommissionMutation,
	rebaselineMutation,
} from "../modules/modems/mutation-acknowledge.ts";
import {
	currentMutationBlocks,
	refreshMutationBlocks,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	streamingBlockingMutation,
	tryAcquireLifecycle,
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
import { useReplayHarness } from "./helpers/journal-replay-harness.ts";
import {
	journalFiles,
	retirementFault,
} from "./helpers/journal-retirement-harness.ts";

const harness = useReplayHarness();
function rejectTerminalTransitions(): void {
	let remaining = 2;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			rename: async (from, to) => {
				const value = modemMutationEntrySchema.parse(
					JSON.parse(await readFile(from, "utf8")),
				);
				if (
					(value.state === "completed" || value.state === "failed") &&
					remaining-- > 0
				) {
					throw Object.assign(new Error("transition EIO"), { code: "EIO" });
				}
				await defaultMutationJournalFs.rename(from, to);
			},
		},
	});
}
for (const action of [
	"verified-rollback",
	"force-rebaseline",
	"rebaseline",
] as const) {
	test(`${action} returns typed retirement failure and a second operator attempt finishes its durable decision`, async () => {
		// Given an actual blocked slot and one unlink failure after the operator decision commits.
		await seedFailedMutation("usb:b");
		if (action === "rebaseline") {
			const entry = await readMutationEntry("usb:b");
			if (!entry) throw new Error("missing seeded entry");
			await commitMutationEntry({ ...entry, state: "recommission-pending" });
		}
		await initMutationRecovery();
		const blocks = currentMutationBlocks();
		const fault = retirementFault(harness.root(), 1);
		const invoke = () =>
			action === "rebaseline"
				? rebaselineMutation("usb:b")
				: acknowledgeMutation("usb:b", action);
		// When removal fails, the typed boundary must not reject or manufacture success.
		expect(await invoke()).toEqual({
			success: false,
			error: "journal_write_failed",
		});
		expect((await readMutationEntry("usb:b"))?.state).toBe("acknowledged");
		expect((await readMutationEntry("usb:b"))?.acknowledgedMode).toBe(
			action === "verified-rollback" ? "verified-rollback" : "force-rebaseline",
		);
		expect(currentMutationBlocks()).toEqual(blocks);
		expect(journalFiles(harness.root())).toHaveLength(1);
		expect(fault.unlinks()).toBe(1);
		// Then retry resumes retirement, without overwriting the accepted hardware baseline.
		const decision = await readMutationEntry("usb:b");
		expect(await invoke()).toEqual({ success: true, state: "acknowledged" });
		expect(decision?.preState.mode).toBe("qmi");
		expect(fault.unlinks()).toBe(2);
		expect(currentMutationBlocks()).toEqual([]);
		expect(journalFiles(harness.root())).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
	});
}

test("decommission retains its entry and does not invoke the removal primitive", async () => {
	// Given quarantined authority: decommission is not archival retirement.
	await seedFailedMutation("usb:b");
	const entry = await readMutationEntry("usb:b");
	if (!entry) throw new Error("missing seeded entry");
	await commitMutationEntry({ ...entry, state: "device-absent-quarantine" });
	await refreshMutationBlocks();
	const fault = retirementFault(harness.root(), Number.POSITIVE_INFINITY);
	// When the operator confirms absence, even a faulting unlink port is irrelevant.
	expect(await decommissionMutation("usb:b")).toEqual({
		success: true,
		state: "decommissioned",
	});
	// Then the durable retained decision blocks only the identity, never streaming.
	expect(fault.unlinks()).toBe(0);
	expect((await readMutationEntry("usb:b"))?.state).toBe("decommissioned");
	expect(
		currentMutationBlocks().map((block) => [
			block.state,
			block.blocksStreaming,
		]),
	).toEqual([["decommissioned", false]]);
	expect(streamingBlockingMutation()).toBeUndefined();
});

test("a lease finalizer unlink EIO returns refusal, releases its lease and retains confirmed authority", async () => {
	// Given no journal at startup and one finalizer retirement failure.
	await initMutationRecovery();
	const fault = retirementFault(harness.root(), 1);
	// When a confirmed connectivity mutation cannot retire its actual executing entry.
	expect(
		await withJournaledModemMutation(
			"usb:b",
			"usb-mode",
			{ mode: "qmi" },
			async (mutation) => {
				await mutation.markExecuting();
				return { confirmed: true, value: "confirmed" };
			},
		),
	).toEqual({ ok: false, refusal: "mutation_blocked" });
	// Then confirmed authority survives without an executing wedge or held lease.
	expect(fault.unlinks()).toBe(1);
	expect((await readMutationEntry("usb:b"))?.state).toBe("completed");
	expect(isRecoveryPending()).toBe(false);
	const lease = tryAcquireLifecycle("streaming");
	expect(lease.admitted).toBe(true);
	if (lease.admitted) lease.lease.release();
	expect(streamingBlockingMutation()).toBeUndefined();
	expect(journalFiles(harness.root())).toHaveLength(1);
	const admission = tryAcquireModemMutation("usb:b");
	expect(admission.admitted).toBe(true);
	if (admission.admitted) admission.lease.release();
	expect((await initMutationRecovery()).pruned).toBe(1);
	expect(journalFiles(harness.root())).toEqual([]);
});

test("a failed completion and failed failure-write retain settlement ownership after the lease releases", async () => {
	// Given two natural transition-write EIOs with real executing authority retained.
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	let effects = 0;
	rejectTerminalTransitions();
	// When hardware is confirmed but neither completion nor fallback failure can commit.
	await expect(
		withJournaledModemMutation(
			"usb:b",
			"usb-mode",
			{ mode: "qmi" },
			async (mutation) => {
				await mutation.markExecuting();
				effects++;
				return { confirmed: true, value: "confirmed" };
			},
		),
	).rejects.toThrow("transition EIO");
	// Then one owner retries bookkeeping, not hardware, and failed becomes acknowledgeable.
	expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000]);
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	expect(isRecoveryPending()).toBe(true);
	expect(clock.waits).toEqual([1000, 2000]);
	clock.advance();
	await Promise.race([done, clock.at(3)]);
	expect(effects).toBe(1);
	expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
	expect(isRecoveryPending()).toBe(false);
	expect(await acknowledgeMutation("usb:b", "force-rebaseline")).toEqual({
		success: true,
		state: "acknowledged",
	});
	const admission = tryAcquireModemMutation("usb:b");
	expect(admission.admitted).toBe(true);
	if (admission.admitted) admission.lease.release();
});

test("pending failed-state settlement cannot overwrite a newer attempt", async () => {
	// Given retained failed bookkeeping behind executing authority and its recovery barrier.
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	rejectTerminalTransitions();
	await expect(
		withJournaledModemMutation("usb:b", "usb-mode", {}, async (mutation) => {
			await mutation.markExecuting();
			return { confirmed: true, value: 1 };
		}),
	).rejects.toThrow("transition EIO");
	expect(isRecoveryPending()).toBe(true);
	await seedFailedMutation("usb:b");
	const newer = await readMutationEntry("usb:b");
	// When another authoritative attempt replaced the slot before settlement.
	const done = awaitRecoveryBarrier();
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	// Then the pending old failure is retired, not written over newer authority.
	expect(await readMutationEntry("usb:b")).toEqual(newer);
	expect((await readMutationEntry("usb:b"))?.attemptId).toBe("retained");
	expect(isRecoveryPending()).toBe(false);
});
