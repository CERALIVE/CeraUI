import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
} from "../../modules/modems/mutation-journal.ts";
import { setMutationCaptureDeps } from "../../modules/modems/mutation-rollback.ts";
import {
	deferred,
	useJournalReconciliationHarness,
} from "./journal-reconciliation-harness.ts";

export const replayHardware = (key: string, productId = "0801") => ({
	vendorId: "2c7c",
	productId,
	physicalUid: key,
	model: "fixture",
	firmwareRevision: "one",
	ifname: "wwan0",
	bDeviceClass: 0,
	interfaces: [
		{
			interfaceClass: 255,
			interfaceSubClass: 255,
			interfaceProtocol: 255,
			driver: "qmi_wwan",
		},
	],
});

export async function seedInterruptedMutation(): Promise<void> {
	await commitMutationEntry({
		version: 1,
		stableKey: "usb:b",
		kind: "usb-mode",
		state: "executing",
		attemptId: "interrupted",
		startedAt: 1,
		updatedAt: 1,
		preState: {
			vidPid: "2c7c:0801",
			model: "fixture",
			firmwareRevision: "one",
			mode: "qmi",
		},
		history: [
			{ state: "armed", at: 1 },
			{ state: "executing", at: 1 },
		],
	});
}

/** Fault the real anchored census, not a fabricated replay verdict. */
export async function invalidateReplayRead(root: string): Promise<void> {
	const fault = spyOn(fs, "readdir").mockRejectedValueOnce(
		Object.assign(new Error("EIO held replay"), { code: "EIO" }),
	);
	try {
		await expect(defaultMutationJournalFs.listDir(root)).rejects.toThrow(
			"EIO held replay",
		);
	} finally {
		fault.mockRestore();
	}
}

export function useReplayHarness() {
	const journal = useJournalReconciliationHarness();
	const holds: ReturnType<typeof deferred>[] = [];
	beforeEach(() =>
		setMutationCaptureDeps({
			enumerate: async () => [replayHardware("usb:a"), replayHardware("usb:b")],
		}),
	);
	afterEach(() => {
		for (const hold of holds.splice(0)) hold.release();
	});
	return {
		...journal,
		pauseRollback: () => {
			const entered = deferred();
			const hold = deferred();
			holds.push(hold);
			let captures = 0;
			setMutationCaptureDeps({
				enumerate: async () => {
					if (++captures === 1) {
						entered.release();
						await hold.promise;
					}
					return [replayHardware("usb:a"), replayHardware("usb:b")];
				},
			});
			return {
				entered: entered.promise,
				release: hold.release,
				captures: () => captures,
			};
		},
	};
}

/** Observe the real replay summary emitted by the automatic owner's attempt. */
export function observeReplaySummaries() {
	const info = spyOn(logger, "info");
	return {
		restore: () => info.mockRestore(),
		values: (): readonly unknown[] =>
			info.mock.calls.flatMap((call) => {
				const value: unknown = Array.from<unknown>(call)[1];
				return typeof value === "object" &&
					value !== null &&
					"rolledBack" in value
					? [value]
					: [];
			}),
	};
}
