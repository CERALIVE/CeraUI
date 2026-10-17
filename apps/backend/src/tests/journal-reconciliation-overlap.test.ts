import { expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
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
	useJournalReconciliationHarness,
} from "./helpers/journal-reconciliation-harness.ts";

const harness = useJournalReconciliationHarness();
test("acknowledgement cannot remove a newer failed entry after its hardware capture was overtaken", async () => {
	// Given a real failed entry captured by an acknowledgement still awaiting hardware.
	await seedFailedMutation();
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	const capture = harness.pauseCapture();
	const old = acknowledgeMutation("usb:a", "verified-rollback");
	await capture.entered;
	const entry = await readMutationEntry("usb:a");
	if (!entry) throw new Error("missing fixture entry");
	// When a cooperating writer replaces the entry before hardware enumeration returns.
	await commitMutationEntry({
		...entry,
		attemptId: "new-attempt",
		updatedAt: 99,
	});
	capture.release();
	const outcome = await old;
	// Then old hardware evidence cannot retire the new attempt or claim acknowledgement.
	expect(outcome).toEqual({ success: false, error: "not_blocked" });
	expect((await readMutationEntry("usb:a"))?.attemptId).toBe("new-attempt");
});

test("startup presence replay cannot overwrite a newer journal decision after its capture await", async () => {
	// Given a quarantined real entry awaiting startup's presence recheck.
	await seedFailedMutation();
	const entry = await readMutationEntry("usb:a");
	if (!entry) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, state: "device-absent-quarantine" });
	const capture = harness.pauseCapture();
	const replay = initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	await capture.entered;
	// When a newer failed attempt is recorded during enumeration.
	await commitMutationEntry({
		...entry,
		attemptId: "new-attempt",
		updatedAt: 99,
	});
	capture.release();
	await replay;
	// Then replay cannot advance captured old authority over the current entry.
	expect((await readMutationEntry("usb:a"))?.attemptId).toBe("new-attempt");
	expect(currentMutationBlocks()).toEqual([
		{
			stableKey: "usb:a",
			kind: "usb-mode",
			state: "failed",
			updatedAt: 99,
			devicePresent: true,
			blocksStreaming: true,
		},
	]);
});
for (const order of ["verification-first", "acknowledgement-first"] as const) {
	for (const refreshFault of [false, true]) {
		test(`${order}: acknowledgement ${refreshFault ? "EIO" : "success"} cannot be overwritten by an older verifier`, async () => {
			// Given a real failed slot, completed startup and one runtime census EIO.
			await seedFailedMutation();
			const clock = new JournalRetryClock();
			await initMutationRecovery({ sleep: clock.sleep });
			const fault = spyOn(fs, "readdir").mockRejectedValueOnce(
				Object.assign(new Error("EIO census"), { code: "EIO" }),
			);
			try {
				await expect(
					defaultMutationJournalFs.listDir(harness.root()),
				).rejects.toThrow("EIO census");
				let lowered = 0;
				const done = awaitRecoveryBarrier().then(() => {
					lowered++;
				});
				const presence = harness.pausePresence();
				const capture =
					order === "acknowledgement-first"
						? harness.pauseCapture()
						: undefined;
				const earlierAck = capture
					? acknowledgeMutation("usb:a", "verified-rollback")
					: undefined;
				if (capture) await capture.entered;
				clock.advance();
				await presence.entered;
				if (refreshFault)
					fault.mockRejectedValueOnce(
						Object.assign(new Error("EIO ack refresh"), { code: "EIO" }),
					);
				// When acknowledgement removes the slot while the older presence read is held.
				capture?.release();
				const ack =
					earlierAck ?? acknowledgeMutation("usb:a", "verified-rollback");
				if (refreshFault) await expect(ack).rejects.toThrow("EIO ack refresh");
				else
					expect(await ack).toEqual({ success: true, state: "acknowledged" });
				expect(readdirSync(harness.root())).toEqual([]);
				if (!refreshFault) expect(currentMutationBlocks()).toEqual([]);
				presence.release();
				await Promise.race([clock.at(2), done]);
				// Then the invalidated pass neither republishes the removed slot nor completes.
				if (!refreshFault) expect(currentMutationBlocks()).toEqual([]);
				expect(isRecoveryPending()).toBe(true);
				expect(lowered).toBe(0);
				expect(clock.waits).toEqual([1000, 2000]);
				clock.advance();
				await done;
				expect(lowered).toBe(1);
				expect(isRecoveryPending()).toBe(false);
				expect(currentMutationBlocks()).toEqual([]);
				expect(streamingBlockingMutation()).toBeUndefined();
				const admission = tryAcquireModemMutation("usb:a");
				expect(admission.admitted).toBe(true);
				if (admission.admitted) admission.lease.release();
				expect(await acknowledgeMutation("usb:a", "verified-rollback")).toEqual(
					{ success: false, error: "no_entry" },
				);
			} finally {
				fault.mockRestore();
			}
		});
	}
}

test("a new failed commit invalidates the paused inventory and is published by the final pass", async () => {
	// Given the real runtime owner holding the old one-slot inventory.
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const fault = spyOn(fs, "readdir").mockRejectedValueOnce(
		Object.assign(new Error("EIO census"), { code: "EIO" }),
	);
	try {
		await expect(
			defaultMutationJournalFs.listDir(harness.root()),
		).rejects.toThrow("EIO census");
		const done = awaitRecoveryBarrier();
		const presence = harness.pausePresence();
		clock.advance();
		await presence.entered;
		// When a cooperating writer commits a second failed mutation mid-verification.
		await seedFailedMutation("usb:b");
		presence.release();
		await Promise.race([clock.at(2), done]);
		// Then no obsolete one-slot proof opens admission; the next pass includes both.
		expect(isRecoveryPending()).toBe(true);
		expect(clock.waits).toEqual([1000, 2000]);
		clock.advance();
		await done;
		expect(
			currentMutationBlocks()
				.map((b) => b.stableKey)
				.sort(),
		).toEqual(["usb:a", "usb:b"]);
		expect(tryAcquireModemMutation("usb:b")).toEqual({
			admitted: false,
			refusal: "mutation_blocked",
		});
		expect(isRecoveryPending()).toBe(false);
	} finally {
		fault.mockRestore();
	}
});
