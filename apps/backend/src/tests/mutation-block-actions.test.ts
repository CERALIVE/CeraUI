import { expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { call } from "@orpc/server";
import { refreshMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { mutationSlotName } from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { streamingBlockingMutation } from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	acknowledgeMutationProcedure,
	listMutationBlocksProcedure,
} from "../rpc/procedures/modems.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import {
	JournalRetryClock,
	seedFailedMutation,
} from "./helpers/journal-reconciliation-harness.ts";
import { useReplayHarness } from "./helpers/journal-replay-harness.ts";

const harness = useReplayHarness();

async function listActions() {
	const { blocks, replayComplete } = await call(
		listMutationBlocksProcedure,
		undefined,
		{ context: makeRpcContext() },
	);
	return {
		replayComplete,
		checkable: Object.fromEntries(
			blocks.map((row) => [row.stableKey, row.checkable]),
		),
	};
}

const checkAgain = (stableKey: string) =>
	call(
		acknowledgeMutationProcedure,
		{ stableKey, mode: "verified-rollback", confirm: true },
		{ context: makeRpcContext() },
	);

const slot = (key: string) =>
	join(harness.root(), `${mutationSlotName(key)}.json`);

test("a failed directory census hides Check again until recovery republishes", async () => {
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	expect(await listActions()).toEqual({
		replayComplete: true,
		checkable: { "usb:a": true },
	});
	const readdir = spyOn(fs, "readdir").mockRejectedValueOnce(
		new Error("journal directory enumeration failed"),
	);
	try {
		await expect(refreshMutationBlocks()).rejects.toThrow(
			"journal directory enumeration failed",
		);
	} finally {
		readdir.mockRestore();
	}

	expect(await listActions()).toEqual({
		replayComplete: false,
		checkable: { "usb:a": false },
	});

	clock.advance();
	await Promise.race([awaitRecoveryBarrier(), clock.at(2)]);
	expect(await listActions()).toEqual({
		replayComplete: true,
		checkable: { "usb:a": true },
	});
});

test("Check again stays hidden on a newly unreadable slot until a new publication", async () => {
	await seedFailedMutation();
	await seedFailedMutation("usb:b");
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	unlinkSync(slot("usb:b"));
	mkdirSync(slot("usb:b"));

	expect(await listActions()).toEqual({
		replayComplete: false,
		checkable: { "usb:a": false, "usb:b": false },
	});
	await expect(checkAgain("usb:b")).rejects.toThrow("not_regular_file");
	expect(isRecoveryPending()).toBe(true);
});

test("a journal commit during the list RPC invalidates its Check again hints", async () => {
	await seedFailedMutation();
	await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
	const capture = harness.pauseCapture();
	const pending = listActions();
	try {
		expect(
			await Promise.race([capture.entered.then(() => "capture"), pending]),
		).toBe("capture");
		await seedFailedMutation("usb:b");
	} finally {
		capture.release();
	}

	expect(await pending).toEqual({
		replayComplete: true,
		checkable: { "usb:a": false },
	});
});

for (const phase of ["first-seen", "carried"] as const) {
	for (const fault of ["torn", "unreadable"] as const) {
		test(`${phase} ${fault} journal damage leaves the readable neighbor checkable`, async () => {
			await seedFailedMutation();
			const damaged = slot("usb:b");
			const clock = new JournalRetryClock();
			if (phase === "carried") {
				await seedFailedMutation("usb:b");
				await initMutationRecovery({ sleep: clock.sleep });
				expect(await listActions()).toEqual({
					replayComplete: true,
					checkable: { "usb:a": true, "usb:b": true },
				});
				unlinkSync(damaged);
			}
			if (fault === "torn") writeFileSync(damaged, "{");
			else mkdirSync(damaged);

			if (phase === "carried") await refreshMutationBlocks();
			else await initMutationRecovery({ sleep: clock.sleep });
			const blocked = phase === "carried" ? { "usb:b": false } : {};
			expect(await listActions()).toEqual({
				replayComplete: false,
				checkable: { "usb:a": true, ...blocked },
			});
			expect(await checkAgain("usb:a")).toEqual({
				success: true,
				state: "acknowledged",
			});
			expect(existsSync(slot("usb:a"))).toBe(false);
			expect(await listActions()).toEqual({
				replayComplete: false,
				checkable: blocked,
			});
			expect(streamingBlockingMutation()?.stableKey).toBe(
				phase === "carried" ? "usb:b" : undefined,
			);
			if (fault === "torn") {
				expect(await checkAgain("usb:b")).toEqual({
					success: false,
					error: "no_entry",
				});
				expect(readFileSync(damaged, "utf8")).toBe("{");
			} else {
				await expect(checkAgain("usb:b")).rejects.toThrow("not_regular_file");
				expect(statSync(damaged).isDirectory()).toBe(true);
			}
			expect(isRecoveryPending()).toBe(true);
		});
	}
}
