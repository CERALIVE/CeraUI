import { expect, spyOn, test } from "bun:test";
import * as udev from "../modules/modems/modem-id-path-source.ts";
import { currentMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import { readMutationEntry } from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { routerUsbSysfs } from "../modules/modems/router-subnet-recovery-device.ts";
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
		const gone = action.name === "decommission";
		const key = gone ? "platform-xhci-hcd.0.auto-usb-0:1" : "usb:b";
		// Given eligible authority, and the oracle's retained acknowledged decision for removing actions.
		await seedRetirement(action.state, key);
		await initMutationRecovery({ sleep: new JournalRetryClock().sleep });
		if (gone) await seedRetirement(action.state, key);
		if (!gone) {
			retirementFault(harness.root(), 1);
			expect(await action.invoke(key)).toEqual({
				success: false,
				error: "journal_write_failed",
			});
			expect((await readMutationEntry(key))?.state).toBe("acknowledged");
			expect(isModemMutationHeld(key)).toBe(false);
			expect(
				await withJournaledModemMutation("usb:a", "usb-mode", {}, async () => ({
					confirmed: true,
					value: "a",
				})),
			).toEqual({ ok: true, value: "a" });
			expect(currentMutationBlocks()).toEqual([]);
		}
		const inventory = gone
			? spyOn(udev, "readUdevExportDb").mockResolvedValue(
					"P: /devices/platform/xhci-hcd.0.auto/usb1\nE: SUBSYSTEM=usb\n",
				)
			: undefined;
		const buses = gone
			? spyOn(routerUsbSysfs, "names").mockReturnValue(["usb1"])
			: undefined;
		const root = gone
			? spyOn(routerUsbSysfs, "rootPath").mockReturnValue(
					"/sys/devices/platform/xhci-hcd.0.auto/usb1",
				)
			: undefined;
		const held = holdRetirement(harness.root(), gone, key);
		const retirement = action.invoke(key);
		try {
			await Promise.race([held.entered, retirement]);
			const before = journalBytes(harness.root(), key);
			// When a new ordinary mutation tries to arm while old retirement's effect is pending
			// (a quarantined slot keeps its published block ahead of the lease in the frozen order).
			expect(
				await withJournaledModemMutation(
					key,
					"usb-mode",
					{},
					async (mutation) => {
						await mutation.markExecuting();
						return { confirmed: false, value: "newer" };
					},
				),
			).toEqual({
				ok: false,
				refusal: gone ? "mutation_blocked" : "mutation_in_progress",
			});
			expect(journalBytes(harness.root(), key)).toEqual(before);
			expect(isModemMutationHeld(key)).toBe(true);
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
				state: gone ? "decommissioned" : "acknowledged",
			});
			expect(isModemMutationHeld(key)).toBe(false);
		} finally {
			held.release();
			await retirement;
			inventory?.mockRestore();
			buses?.mockRestore();
			root?.mockRestore();
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
