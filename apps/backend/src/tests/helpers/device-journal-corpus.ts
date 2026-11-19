import type { LogLevel, LogSource } from "@ceraui/rpc/schemas";
import type { RawJournalRecord } from "../../modules/device-logs/parse.ts";

export interface JournalCorpusCase {
	readonly name: string;
	readonly input: unknown;
	readonly expected: RawJournalRecord | null;
}

/** Expected labels are explicit; the corpus does not call the parser or catalog. */
export function journalCorpus(): JournalCorpusCase[] {
	const cases: JournalCorpusCase[] = [];
	const base = {
		__REALTIME_TIMESTAMP: "1700000000000999",
		_BOOT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		MESSAGE: "hello",
	};
	const add = (
		name: string,
		fields: Record<string, unknown>,
		expected: Partial<RawJournalRecord> = {},
	) => {
		const cursor = `case=${cases.length}`;
		cases.push({
			name,
			input: { ...base, __CURSOR: cursor, ...fields },
			expected: {
				cursor,
				ts: 1700000000000,
				bootId: base._BOOT_ID,
				level: "info",
				unit: "system",
				source: null,
				message: "hello",
				truncated: false,
				marker: null,
				messageId: null,
				unitField: null,
				pid: null,
				...expected,
			},
		});
	};
	const units: readonly [unknown, string | null, LogSource | null][] = [
		[undefined, null, null],
		["", null, null],
		[" ", null, null],
		["session-2.scope", null, null],
		["init.scope", null, null],
		["-.slice", null, null],
		["data.mount", null, null],
		["other.socket", null, null],
		["job.timer", null, null],
		["ceralive.service", "ceralive", "app"],
		["user@1000.service", "user@1000", null],
		["foo@bar.service", "foo@bar", null],
		["foo@.service", "foo@", null],
		["u.service", "u", null],
		[".service", null, null],
		[" leading.service", " leading", null],
		["foo.service ", null, null],
		["foo.SERVICE", null, null],
		["foo.service.service", "foo.service", null],
	];
	for (const [unit, serviceLabel, source] of units) {
		for (const [identifier, label] of [
			[undefined, "system"],
			["", "system"],
			["fallback", "fallback"],
			["  ", "  "],
		] as const) {
			for (const transport of [
				"kernel",
				"syslog",
				"journal",
				"stdout",
				"audit",
			]) {
				add(
					`unit=${String(unit)} id=${String(identifier)} via=${transport}`,
					{
						_SYSTEMD_UNIT: unit,
						SYSLOG_IDENTIFIER: identifier,
						_TRANSPORT: transport,
					},
					{
						unit: serviceLabel ?? label,
						source: transport === "kernel" ? "kernel" : source,
					},
				);
			}
		}
	}
	const priorities: readonly [unknown, LogLevel][] = [
		["0", "error"],
		["1", "error"],
		["2", "error"],
		["3", "error"],
		["4", "warning"],
		["5", "info"],
		["6", "info"],
		["7", "debug"],
		[0, "error"],
		[1, "error"],
		[2, "error"],
		[3, "error"],
		[4, "warning"],
		[5, "info"],
		[6, "info"],
		[7, "debug"],
		[undefined, "info"],
		[null, "info"],
		[9, "info"],
		["9", "info"],
		["03", "info"],
		[" 3", "info"],
		["+3", "info"],
	];
	const messages: readonly [unknown, string, boolean][] = [
		["hello", "hello", false],
		["", "", false],
		["a\0b\nc", "a\0b\nc", false],
		[[104, 195, 169], "h\u00e9", false],
		[[195, 40, 255], "\ufffd(\ufffd", false],
		[[7, null, "first", "second"], "first", false],
		[[], "", false],
		[null, "", true],
		[undefined, "", true],
		[[256], "", true],
		[{ hostile: true }, "", true],
	];
	for (const [priority, level] of priorities) {
		for (const [raw, message, truncated] of messages) {
			add(
				`priority=${String(priority)} message=${JSON.stringify(raw)}`,
				{
					PRIORITY: priority,
					MESSAGE: raw,
				},
				{ level, message, truncated },
			);
		}
		for (const [legacy, override] of [
			["error", "error"],
			["warn", "warning"],
			["info", "info"],
			["debug", "debug"],
		] as const) {
			add(
				`priority=${String(priority)} legacy=${legacy}`,
				{
					PRIORITY: priority,
					MESSAGE: JSON.stringify({
						ts: "x",
						msg: "saved",
						module: "m",
						meta: { n: 1 },
						level: legacy,
					}),
				},
				{ level: override, message: '[m] saved {"n":1}' },
			);
		}
	}
	for (const legacy of [
		"warning",
		"INFO",
		"constructor",
		"__proto__",
		["info"],
		null,
	]) {
		add(
			`unsupported legacy=${JSON.stringify(legacy)}`,
			{
				PRIORITY: "3",
				MESSAGE: JSON.stringify({ ts: "x", msg: "saved", level: legacy }),
			},
			{ level: "error", message: "saved" },
		);
	}
	for (const [MESSAGE, message] of [
		['{"ts":broken', '{"ts":broken'],
		['{"ts":1,"msg":42,"level":"info"}', '{"ts":1,"msg":42,"level":"info"}'],
		[
			' {"ts":1,"msg":"x","level":"info"}',
			' {"ts":1,"msg":"x","level":"info"}',
		],
	] as const)
		add(
			`literal ${MESSAGE}`,
			{ MESSAGE, PRIORITY: "3" },
			{ message, level: "error" },
		);
	add(
		"oversized multibyte message",
		{ MESSAGE: "\u00e9".repeat(8193) },
		{
			message: "\u00e9".repeat(8192),
			truncated: true,
		},
	);
	add(
		"classifier fields",
		{ MESSAGE_ID: "id", UNIT: "shutdown.target", _PID: "1" },
		{
			messageId: "id",
			unitField: "shutdown.target",
			pid: 1,
		},
	);
	add(
		"synthetic suppressed marker only",
		{ MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e" },
		{
			messageId: "a596d6fe7bfa4994828e72309e95d61e",
			marker: "suppressed",
		},
	);
	for (const fields of [
		{ __CURSOR: undefined },
		{ __CURSOR: "" },
		{ __CURSOR: 1 },
		{ __REALTIME_TIMESTAMP: undefined },
		{ __REALTIME_TIMESTAMP: "" },
		{ __REALTIME_TIMESTAMP: NaN },
		{ __REALTIME_TIMESTAMP: -1 },
		{ _BOOT_ID: undefined },
		{ _BOOT_ID: "A".repeat(32) },
	])
		cases.push({
			name: `malformed ${JSON.stringify(fields)}`,
			input: { ...base, __CURSOR: "x", ...fields },
			expected: null,
		});
	return cases;
}
