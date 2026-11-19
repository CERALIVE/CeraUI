import { describe, expect, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import { parseRecord, toLogEntry } from "../modules/device-logs/parse.ts";
import { bootId, journalObject } from "./helpers/device-journal-record.ts";

describe("journal record boundary", () => {
	test("projects the journal fields and strips classifier-only fields", () => {
		const record = parseRecord(
			journalObject({
				_SYSTEMD_UNIT: "ceralive.service",
				PRIORITY: "3",
				MESSAGE_ID: "lifecycle",
				UNIT: "shutdown.target",
				_PID: "1",
			}),
		);
		expect(record).toEqual({
			cursor: "s=1",
			ts: 1700000000000,
			bootId,
			level: "error",
			source: "app",
			unit: "ceralive",
			message: "hello",
			truncated: false,
			marker: null,
			messageId: "lifecycle",
			unitField: "shutdown.target",
			pid: 1,
		});
		if (!record) throw new Error("fixture record was skipped");
		const entry = toLogEntry(record);
		expect(Object.keys(entry).sort()).toEqual([
			"bootId",
			"cursor",
			"level",
			"marker",
			"message",
			"source",
			"truncated",
			"ts",
			"unit",
		]);
		expect(logEntrySchema.parse(entry)).toEqual(entry);
		expect(record.messageId).toBe("lifecycle");
	});

	test.each([
		["1700000000000999", 1700000000000],
		["1700000000000000", 1700000000000],
		["1700000000000001", 1700000000000],
		["9007199254740991", 9007199254740],
		[0, 0],
	])("floors microseconds %s to integer milliseconds %s", (raw, expected) => {
		const record = parseRecord(journalObject({ __REALTIME_TIMESTAMP: raw }));
		expect(record?.ts).toBe(expected);
		if (!record) throw new Error("valid timestamp was skipped");
		expect(logEntrySchema.safeParse(toLogEntry(record)).success).toBe(true);
	});

	test.each(
		[
			undefined,
			null,
			"",
			" ",
			"abc",
			"-1",
			-1,
			NaN,
			Infinity,
			true,
			[],
			"Infinity",
			"1.2",
			"0x10",
			"9007199254740992",
			[1],
		].map((raw) => ({ raw })),
	)("skips malformed timestamp %j", ({ raw }) => {
		expect(
			parseRecord(journalObject({ __REALTIME_TIMESTAMP: raw })),
		).toBeNull();
	});

	test.each([undefined, null, "", 42, ["s=1"]].map((cursor) => ({ cursor })))(
		"skips absent or malformed cursor %j",
		({ cursor }) => {
			expect(parseRecord(journalObject({ __CURSOR: cursor }))).toBeNull();
		},
	);
	test.each(
		[null, undefined, [], "not an object", 1].map((record) => ({ record })),
	)("skips non-record JSON %j", ({ record }) =>
		expect(parseRecord(record)).toBeNull(),
	);

	test.each([undefined, "", "A".repeat(32), "a".repeat(31)])(
		"never fabricates a boot identity for %j",
		(raw) => expect(parseRecord(journalObject({ _BOOT_ID: raw }))).toBeNull(),
	);

	test.each([
		["0", "error"],
		["1", "error"],
		["2", "error"],
		["3", "error"],
		["4", "warning"],
		["5", "info"],
		["6", "info"],
		["7", "debug"],
		[undefined, "info"],
		["bad", "info"],
		["8", "info"],
		[4, "warning"],
		[{ toString: 42 }, "info"],
		[["4"], "info"],
	] as const)("priority %j becomes %s", (priority, level) => {
		expect(parseRecord(journalObject({ PRIORITY: priority }))?.level).toBe(
			level,
		);
	});

	test.each([
		[{ _SYSTEMD_UNIT: "ssh.service" }, "ssh", "device"],
		[{ _SYSTEMD_UNIT: "apt-daily.service" }, "apt-daily", "updates"],
		[{ _SYSTEMD_UNIT: "other.socket" }, "system", null],
		[{ SYSLOG_IDENTIFIER: "driver" }, "driver", null],
		[{ SYSLOG_IDENTIFIER: "ssh.service" }, "ssh.service", "device"],
		[{}, "system", null],
		[
			{ _TRANSPORT: "kernel", _SYSTEMD_UNIT: "ceralive.service" },
			"ceralive",
			"kernel",
		],
	] as const)("unit and source of %j", (fields, unit, source) => {
		expect(parseRecord(journalObject(fields))).toMatchObject({ unit, source });
	});

	test.each(
		[
			undefined,
			"",
			"NaN",
			"-1",
			"1.5",
			{},
			"0",
			" 1",
			"1e2",
			"0x10",
			"9007199254740992",
			1,
			["1"],
			true,
		].map((pid) => ({ pid })),
	)("invalid pid %j stays unknown", ({ pid }) =>
		expect(parseRecord(journalObject({ _PID: pid }))?.pid).toBeNull(),
	);
	test("missing classifier fields remain explicit nulls", () => {
		expect(parseRecord(journalObject())).toMatchObject({
			messageId: null,
			unitField: null,
			pid: null,
		});
	});
	test("empty string fields are absent and one-character fields stay valid", () => {
		expect(
			parseRecord(
				journalObject({
					_SYSTEMD_UNIT: "",
					SYSLOG_IDENTIFIER: "i",
					MESSAGE_ID: "",
					UNIT: "",
				}),
			),
		).toMatchObject({ unit: "i", messageId: null, unitField: null });
		expect(
			parseRecord(
				journalObject({
					__CURSOR: "x",
					_SYSTEMD_UNIT: "u",
					MESSAGE_ID: "m",
					UNIT: "t",
				}),
			),
		).toMatchObject({
			cursor: "x",
			unit: "system",
			messageId: "m",
			unitField: "t",
		});
	});

	test.each([
		["ceralive.service", "ceralive"],
		["u.service", "u"],
		["user@1000.service", "user@1000"],
		["foo@bar.service", "foo@bar"],
		["foo@.service", "foo@"],
		["foo.service.service", "foo.service"],
		[" leading.service", " leading"],
	] as const)(
		"service %j wins over its identifier and strips only the last suffix",
		(unit, expected) => {
			expect(
				parseRecord(
					journalObject({
						_SYSTEMD_UNIT: unit,
						SYSLOG_IDENTIFIER: "fallback",
					}),
				)?.unit,
			).toBe(expected);
		},
	);

	for (const unit of [
		"session-2.scope",
		"init.scope",
		"-.slice",
		"data.mount",
		"other.socket",
		"job.timer",
		"u",
		"",
		" ",
		"\t",
		".service",
		"foo.SERVICE",
		"foo.Service",
		"foo.service ",
		"foo.service\n",
	]) {
		test.each([
			["fallback", "fallback"],
			["", "system"],
			[undefined, "system"],
			[null, "system"],
			["  ", "  "],
		] as const)(
			`${JSON.stringify(unit)} falls back through identifier %j`,
			(identifier, expected) => {
				expect(
					parseRecord(
						journalObject({
							_SYSTEMD_UNIT: unit,
							SYSLOG_IDENTIFIER: identifier,
						}),
					)?.unit,
				).toBe(expected);
			},
		);
	}
});
