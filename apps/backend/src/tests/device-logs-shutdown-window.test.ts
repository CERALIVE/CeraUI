import { afterEach, expect, spyOn, test } from "bun:test";
import * as mocks from "../mocks/mock-service.ts";
import * as adapter from "../modules/device-logs/mock-journal.ts";
import * as reader from "../modules/device-logs/reader.ts";
import { readShutdownWindow } from "../modules/device-logs/shutdown-window.ts";
import { bootId, journal, record } from "./helpers/device-query.ts";

afterEach(() => {
	spyOn(mocks, "shouldUseMocks").mockRestore();
	spyOn(adapter, "scanMockJournal").mockRestore();
	spyOn(reader, "scanJournal").mockRestore();
});

test.each([
	["tail", 100],
	["head", 50],
] as const)(
	"the %s window stops at exactly %i records in journal order",
	async (end, limit) => {
		spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
		spyOn(adapter, "scanMockJournal").mockImplementation(() => {
			throw new Error("mock adapter reached for a native boot");
		});
		const rows = Array.from({ length: limit + 1 }, (_, n) => record(n));
		const scan = spyOn(reader, "scanJournal").mockImplementation(
			async (input) => {
				let delivered = 0;
				return journal(rows)({
					...input,
					onRecord(entry) {
						const action = input.onRecord(entry);
						expect(action).toBe(++delivered === limit ? "stop" : "continue");
						return action;
					},
				});
			},
		);
		const result = await readShutdownWindow(bootId, end);
		expect(result.map((entry) => entry.cursor)).toEqual(
			(end === "tail" ? [...rows].reverse() : rows)
				.slice(0, limit)
				.map((r) => r.cursor),
		);
		expect(
			scan.mock.calls.map(([input]) => [input.options, input.matches]),
		).toEqual([[end === "tail" ? ["-r"] : [], [`_BOOT_ID=${bootId}`]]]);
	},
);

test("a short physical EOF returns the available records without padding", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	const rows = [record(1), record(2)];
	spyOn(reader, "scanJournal").mockImplementation(journal(rows));
	expect(await readShutdownWindow(bootId, "head")).toEqual(rows);
});

test("mock reads use only the public mock adapter and never spawn", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	const rows = [record(1)];
	const scan = spyOn(reader, "scanJournal").mockImplementation(() => {
		throw new Error("native scan reached under mocks");
	});
	spyOn(adapter, "scanMockJournal").mockImplementation(journal(rows));
	expect(await readShutdownWindow(bootId, "tail")).toEqual(rows);
	expect(scan).not.toHaveBeenCalled();
});

test.each(["budget", "stopped"] as const)(
	"an incomplete %s window fails instead of caching a partial classification",
	async (status) => {
		spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
		spyOn(reader, "scanJournal").mockImplementation(async (input) => {
			input.onRecord(record(1));
			return { status, exitCode: 143, skippedRecords: 0 };
		});
		await expect(readShutdownWindow(bootId, "tail")).rejects.toMatchObject({
			code: "READ_FAILED",
		});
	},
);
