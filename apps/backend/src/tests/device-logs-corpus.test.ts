import { expect, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import { parseRecord, toLogEntry } from "../modules/device-logs/parse.ts";
import { journalCorpus } from "./helpers/device-journal-corpus.ts";
import { bootId, journalObject } from "./helpers/device-journal-record.ts";

test.each(journalCorpus())("$name", ({ input, expected }) => {
	const record = parseRecord(input);
	expect(record).toEqual(expected);
	if (record && expected) {
		const {
			messageId: _messageId,
			unitField: _unitField,
			pid: _pid,
			...wire
		} = expected;
		expect(toLogEntry(record)).toEqual(wire);
		expect(JSON.stringify(logEntrySchema.parse(toLogEntry(record)))).toBe(
			JSON.stringify(logEntrySchema.parse(wire)),
		);
	}
});

test.each([
	"1e3",
	"1E3",
	"0x10",
	"1e0",
	"abc",
	"1f",
	"ff",
	" 12",
	"12 ",
	"1.5",
	"-1",
	"+1",
	"",
	"1\n",
	"1\r",
	"\n1",
	"\r1",
	"1\u2028",
	"1\u2029",
])("rejects nondecimal timestamp string %j", (__REALTIME_TIMESTAMP) => {
	expect(parseRecord(journalObject({ __REALTIME_TIMESTAMP }))).toBeNull();
});

test.each([
	["1", 0],
	["9007199254740991", 9007199254740],
] as const)("accepts decimal timestamp string %j", (raw, ts) => {
	expect(parseRecord(journalObject({ __REALTIME_TIMESTAMP: raw }))?.ts).toBe(
		ts,
	);
});

test.each([
	{
		name: "fractional numeric timestamp",
		fields: { __REALTIME_TIMESTAMP: 0.5 },
	},
	{
		name: "symbol timestamp",
		fields: { __REALTIME_TIMESTAMP: Symbol("timestamp") },
	},
	{ name: "long boot identity", fields: { _BOOT_ID: "a".repeat(33) } },
	{ name: "prefixed boot identity", fields: { _BOOT_ID: `x${bootId}` } },
	{ name: "suffixed boot identity", fields: { _BOOT_ID: `${bootId}x` } },
	{ name: "multiline boot identity", fields: { _BOOT_ID: `${bootId}\n` } },
	{ name: "nonhex boot identity", fields: { _BOOT_ID: "g".repeat(32) } },
])("rejects $name without coercion or partial matching", ({ fields }) => {
	expect(parseRecord(journalObject(fields))).toBeNull();
});

test.each(["0".repeat(32), "f".repeat(32)])(
	"accepts the full lowercase hexadecimal boot alphabet in %j",
	(_BOOT_ID) => {
		expect(parseRecord(journalObject({ _BOOT_ID }))?.bootId).toBe(_BOOT_ID);
	},
);

test.each(["1\n", "A"])("priority %j stays unclassified info", (PRIORITY) => {
	expect(parseRecord(journalObject({ PRIORITY }))?.level).toBe("info");
});

test.each([
	["09", 9],
	["12", 12],
] as const)("accepts multidigit process identity %j", (_PID, pid) => {
	expect(parseRecord(journalObject({ _PID }))?.pid).toBe(pid);
});

test("a multiline process identity stays unknown", () => {
	expect(parseRecord(journalObject({ _PID: "1\n" }))?.pid).toBeNull();
});

test.each(["1e3", "1E3", "1e0", "1E0"])(
	"an exponent-form process identity %j stays unknown",
	(_PID) => {
		expect(parseRecord(journalObject({ _PID }))?.pid).toBeNull();
	},
);

test("a bigint priority keeps the default level", () => {
	expect(parseRecord(journalObject({ PRIORITY: 1n }))?.level).toBe("info");
});

test("a symbol message remains explicitly unavailable", () => {
	expect(
		parseRecord(journalObject({ MESSAGE: Symbol("message") })),
	).toMatchObject({ message: "", truncated: true });
});

test.each(
	[undefined, Symbol("byte")].map((value) => ({ MESSAGE: [value, "first"] })),
)(
	"mixed message $MESSAGE finds the first string without coercing earlier values",
	({ MESSAGE }) => {
		expect(parseRecord(journalObject({ MESSAGE }))).toMatchObject({
			message: "first",
			truncated: false,
		});
	},
);

test("a symbol process identity stays unknown", () => {
	expect(parseRecord(journalObject({ _PID: Symbol("pid") }))?.pid).toBeNull();
});

test.each(
	[["kernel"], { toString: "kernel" }].map((_TRANSPORT) => ({ _TRANSPORT })),
)(
	"transport $_TRANSPORT is not coerced into a kernel classification",
	({ _TRANSPORT }) => {
		expect(parseRecord(journalObject({ _TRANSPORT }))?.source).toBeNull();
	},
);

test("a different notice id never matches by lexical ordering", () => {
	expect(parseRecord(journalObject({ MESSAGE_ID: "0" }))?.marker).toBeNull();
});

test("structured text without a string message stays literal", () => {
	const MESSAGE = '{"ts":1}';
	expect(parseRecord(journalObject({ MESSAGE }))?.message).toBe(MESSAGE);
});

test.each([undefined, 0, 1, false, true, "", "metadata"])(
	"primitive structured metadata %j is omitted",
	(meta) => {
		const MESSAGE = JSON.stringify({ ts: 1, msg: "saved", meta });
		expect(parseRecord(journalObject({ MESSAGE }))?.message).toBe("saved");
	},
);
