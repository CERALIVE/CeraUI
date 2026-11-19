import { deepStrictEqual } from "node:assert/strict";
import { compileFilter } from "../../src/modules/device-logs/filter.ts";
import type { RawJournalRecord } from "../../src/modules/device-logs/parse.ts";
import { scanJournal } from "../../src/modules/device-logs/reader.ts";
import { matchesResidual } from "../../src/modules/device-logs/residual.ts";

const file = process.argv[2];
if (file === undefined) throw new TypeError("expected the fixture journal path");
const bootId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const records: Omit<RawJournalRecord, "cursor">[] = [];
const result = await scanJournal({
	options: [`--file=${file}`, "-n", "+2"],
	matches: [`_BOOT_ID=${bootId}`, "PRIORITY=3"],
	limits: { recordBytes: 8192 },
	onRecord(record) {
		const { cursor: _cursor, ...fields } = record;
		records.push(fields);
		return "continue";
	},
});
deepStrictEqual(result, { status: "eof", skippedRecords: 0, exitCode: 0 });
deepStrictEqual(records, [
	{
		bootId,
		ts: 1700000000000,
		source: "app",
		unit: "ceralive",
		level: "error",
		message: "x".repeat(5000),
		truncated: false,
		marker: "suppressed",
		messageId: "a596d6fe7bfa4994828e72309e95d61e",
		unitField: "ceralive.service",
		pid: 123,
	},
	{
		bootId,
		ts: 1700000001000,
		source: "kernel",
		unit: "kernel-fixture",
		level: "error",
		message: "kernel fixture",
		truncated: false,
		marker: null,
		messageId: null,
		unitField: null,
		pid: null,
	},
]);
console.log("PASS fixture: CeraUI reader preserves projected fields and a long message");

for (const [source, expected] of [
	["bonding", ["srtla_send: link ready", "receiver ready"]],
	["app", ["app startup"]],
] as const) {
	const filter = { sources: [source], levels: ["info"] as const };
	const selected = { ...filter, levels: [...filter.levels] };
	const messages: string[] = [];
	const scan = await scanJournal({
		options: [`--file=${file}`, "--since=@1700000002"],
		matches: compileFilter(selected, { bootId }).matches,
		onRecord(record) {
			if (matchesResidual(record, selected)) messages.push(record.message);
			return "continue";
		},
	});
	deepStrictEqual(scan, { status: "eof", skippedRecords: 0, exitCode: 0 });
	deepStrictEqual(messages, expected);
}
console.log("PASS fixture: source filters separate app, sender and receiver records");
