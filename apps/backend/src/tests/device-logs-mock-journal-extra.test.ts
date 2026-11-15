import { afterEach, beforeEach, expect, test } from "bun:test";
import * as logging from "../helpers/logger.ts";
import {
	followMockJournal,
	scanMockJournal,
} from "../modules/device-logs/mock-journal.ts";
import type { RawJournalRecord } from "../modules/device-logs/parse.ts";
import { scanInput } from "./helpers/device-journal.ts";

beforeEach(() => logging.clearRecentLogLines());
afterEach(() => logging.clearRecentLogLines());

test.each(["scan", "follow"] as const)(
	"%s delivers a later matching OR group after the first group fails",
	async (mode) => {
		await new Promise<void>((resolve, reject) =>
			logging.logger.write(
				{ message: "later group", level: "debug" },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		const entries: string[] = [];
		const input = {
			...scanInput,
			matches: [
				"_SYSTEMD_UNIT=ssh.service",
				"+",
				"_SYSTEMD_UNIT=ceralive.service",
				"PRIORITY=7",
			],
			onRecord(record: RawJournalRecord) {
				entries.push(record.message);
				return "continue" as const;
			},
		};
		if (mode === "scan") await scanMockJournal(input);
		else {
			const handle = followMockJournal(input);
			handle.abort();
			expect(await handle.exited).toBe(0);
		}
		expect(entries).toEqual(["later group"]);
	},
);

test("follow abort returns no value on its first and repeated calls", async () => {
	const handle = followMockJournal(scanInput);
	expect(handle.abort()).toBeUndefined();
	expect(handle.abort()).toBeUndefined();
	expect(await handle.exited).toBe(0);
});

test.each(["scan", "follow"] as const)(
	"%s rejects an absent field whose value equals another field",
	async (mode) => {
		await new Promise<void>((resolve, reject) =>
			logging.logger.write(
				{ message: "different field", level: "debug" },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		const entries: RawJournalRecord[] = [];
		const input = {
			...scanInput,
			matches: ["SYSLOG_IDENTIFIER=7"],
			onRecord(record: RawJournalRecord) {
				entries.push(record);
				return "continue" as const;
			},
		};
		if (mode === "scan") await scanMockJournal(input);
		else {
			const handle = followMockJournal(input);
			handle.abort();
			expect(await handle.exited).toBe(0);
		}
		expect(entries).toEqual([]);
	},
);
