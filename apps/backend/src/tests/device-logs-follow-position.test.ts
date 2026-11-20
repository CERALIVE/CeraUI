import { expect, test } from "bun:test";
import { resolveFollowPosition } from "../modules/device-logs/follow-position.ts";
import {
	JournalReadError,
	type JournalScanResult,
	type ScanJournalOptions,
} from "../modules/device-logs/reader.ts";
import { bootId, record } from "./helpers/device-query.ts";

test.each([undefined, "s=7"])(
	"position %s examines only one boot-scoped record",
	async (cursor) => {
		const controller = new AbortController();
		let call: ScanJournalOptions | undefined;
		const result = await resolveFollowPosition(
			async (input) => {
				call = input;
				expect(input.onRecord(record(7))).toBe("stop");
				return { status: "stopped", exitCode: 143, skippedRecords: 0 };
			},
			{ bootId, signal: controller.signal },
			cursor,
		);
		expect(result).toBe("s=7");
		expect(call?.options).toEqual(
			cursor === undefined ? ["-r"] : ["--cursor=s=7"],
		);
		expect(call?.matches).toEqual([`_BOOT_ID=${bootId}`]);
		expect(call?.signal).toBe(controller.signal);
	},
);
test.each(["eof", "budget", "stopped"] satisfies JournalScanResult["status"][])(
	"only empty EOF proves an empty boot; empty %s remains a failure otherwise",
	async (status) => {
		const task = resolveFollowPosition(
			async () => ({ status, exitCode: 0, skippedRecords: 0 }),
			{ bootId, signal: new AbortController().signal },
		);
		if (status === "eof") expect(await task).toBeNull();
		else
			await expect(task).rejects.toEqual(new JournalReadError("READ_FAILED"));
	},
);
test("abort during a probe invalidates even a returned head position", async () => {
	const controller = new AbortController();
	await expect(
		resolveFollowPosition(
			async (input) => {
				input.onRecord(record(7));
				controller.abort();
				return { status: "stopped", exitCode: 143, skippedRecords: 0 };
			},
			{ bootId, signal: controller.signal },
		),
	).rejects.toEqual(new JournalReadError("READ_FAILED"));
});
test.each([1, 2])(
	"EOF after %i skipped records cannot prove an empty boot",
	async (skippedRecords) => {
		await expect(
			resolveFollowPosition(
				async () => ({
					status: "eof",
					exitCode: 0,
					skippedRecords,
				}),
				{ bootId, signal: new AbortController().signal },
			),
		).rejects.toEqual(new JournalReadError("READ_FAILED"));
	},
);
test("an unreadable resume position is unavailable without claiming the boot is empty", async () => {
	expect(
		await resolveFollowPosition(
			async () => ({
				status: "eof",
				exitCode: 0,
				skippedRecords: 1,
			}),
			{ bootId, signal: new AbortController().signal },
			"s=7",
		),
	).toBeNull();
});
