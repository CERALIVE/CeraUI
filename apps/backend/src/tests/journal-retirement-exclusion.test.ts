import { expect, spyOn, test } from "bun:test";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { readMutationEntry } from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { isModemMutationHeld } from "../modules/streaming/lifecycle-admission.ts";
import { isRecoveryPending } from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
} from "./helpers/journal-reconciliation-harness.ts";
import { useReplayHarness } from "./helpers/journal-replay-harness.ts";
import {
	journalBytes,
	retirementFault,
} from "./helpers/journal-retirement-harness.ts";
import {
	holdRetirement,
	retirementActions,
	seedRetirement,
} from "./helpers/retirement-exclusion-harness.ts";

type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

const harness = useReplayHarness();
for (const action of retirementActions) {
	test(`${action.name} keeps same-key exclusion through its awaited effect while another key proceeds`, async () => {
		// Given eligible authority, and the oracle's retained acknowledged decision for removing actions.
		await seedRetirement(action.state);
		await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
		if (action.name === "decommission") await seedRetirement(action.state);
		if (action.name !== "decommission") {
			retirementFault(harness.root(), 1);
			expect(await action.invoke("usb:b")).toEqual({
				success: false,
				error: "journal_write_failed",
			});
			expect((await readMutationEntry("usb:b"))?.state).toBe("acknowledged");
			expect(isModemMutationHeld("usb:b")).toBe(false);
			expect(
				await withJournaledModemMutation("usb:a", "usb-mode", {}, async () => ({
					confirmed: true,
					value: "a",
				})),
			).toEqual({ ok: true, value: "a" });
			expect(currentMutationBlocks()).toEqual([]);
		}
		const held = holdRetirement(harness.root(), action.name === "decommission");
		const retirement = action.invoke("usb:b");
		try {
			await Promise.race([held.entered, retirement]);
			const before = journalBytes(harness.root());
			// When a new ordinary mutation tries to arm while old retirement's effect is pending
			// (a quarantined slot keeps its published block ahead of the lease in the frozen order).
			expect(
				await withJournaledModemMutation(
					"usb:b",
					"usb-mode",
					{},
					async (mutation) => {
						await mutation.markExecuting();
						return { confirmed: false, value: "newer" };
					},
				),
			).toEqual({
				ok: false,
				refusal:
					action.name === "decommission"
						? "mutation_blocked"
						: "mutation_in_progress",
			});
			expect(journalBytes(harness.root())).toEqual(before);
			expect(isModemMutationHeld("usb:b")).toBe(true);
			// Then a different physical key is still independent, including its final refresh.
			const other = withJournaledModemMutation(
				"usb:a",
				"usb-mode",
				{},
				async () => ({ confirmed: false, value: "parallel" }),
			);
			expect(await other).toEqual({ ok: true, value: "parallel" });
			held.release();
			expect(await retirement).toEqual({
				success: true,
				state:
					action.name === "decommission" ? "decommissioned" : "acknowledged",
			});
			expect(isModemMutationHeld("usb:b")).toBe(false);
		} finally {
			held.release();
			await retirement;
		}
	});

	test(`${action.name} observes executing authority immediately without waiting or deleting newer bytes`, async () => {
		// Given a real newer mutation first, durably executing inside its held operation.
		await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
		const entered = deferred(),
			hold = deferred();
		const operation = withJournaledModemMutation(
			"usb:b",
			"usb-mode",
			{},
			async (mutation) => {
				await mutation.markExecuting();
				entered.release();
				await hold.promise;
				return { confirmed: true, value: "finished" };
			},
		);
		try {
			await entered.promise;
			const before = journalBytes(harness.root());
			// When the operator arrives during hardware work, it reports today's ineligible state.
			const controller = new AbortController(),
				add = controller.signal.addEventListener.bind(controller.signal);
			const waiter = spyOn(
				controller.signal,
				"addEventListener",
			).mockImplementation(
				(
					type: string,
					callback: AbortListener,
					options?: Parameters<AbortSignal["addEventListener"]>[2],
				) => {
					add(type, callback, options);
					controller.abort();
				},
			);
			try {
				expect(await action.invoke("usb:b", controller.signal)).toEqual({
					success: false,
					error: "not_blocked",
				});
				expect(waiter.mock.calls).toEqual([]);
			} finally {
				waiter.mockRestore();
			}
			// Then neither deletion nor replacement is allowed; the original transaction still owns completion.
			expect(journalBytes(harness.root())).toEqual(before);
			expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
			expect(isModemMutationHeld("usb:b")).toBe(true);
			expect(isRecoveryPending()).toBe(false);
		} finally {
			hold.release();
			await operation;
		}
	});
}

for (const action of retirementActions.filter(
	(action) => action.name !== "decommission",
)) {
	test(`${action.name} serializes two eligible operators and the second observes no_entry`, async () => {
		// Given an eligible acknowledged retry and a held first deletion.
		await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
		await seedRetirement("acknowledged");
		const held = holdRetirement(harness.root(), false);
		const first = action.invoke("usb:b");
		let secondDone = false;
		try {
			await held.entered;
			const second = action.invoke("usb:b").then((result) => {
				secondDone = true;
				return result;
			});
			// When the second observes the same eligible slot, it must not submit a second unlink.
			await readMutationEntry("usb:b");
			expect(held.calls()).toBe(1);
			expect(secondDone).toBe(false);
			held.release();
			expect(await first).toEqual({ success: true, state: "acknowledged" });
			// Then its next observation sees absence after holder completion, not stale authority.
			expect(await second).toEqual({ success: false, error: "no_entry" });
			expect(held.calls()).toBe(1);
		} finally {
			held.release();
			await first;
		}
	});
}
