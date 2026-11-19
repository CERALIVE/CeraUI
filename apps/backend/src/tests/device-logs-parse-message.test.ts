import { expect, spyOn, test } from "bun:test";
import { parseRecord } from "../modules/device-logs/parse.ts";
import { journalObject } from "./helpers/device-journal-record.ts";

test.each([
	["hello\0world\nnext", "hello\0world\nnext", false],
	[[104, 195, 169, 0, 255], "hé\0�", false],
	[[null, 4, "first", "last"], "first", false],
	[[], "", false],
	[[null, {}], "", true],
	[null, "", true],
	[undefined, "", true],
	[{}, "", true],
	[[256], "", true],
	[[-1], "", true],
	[[1.5], "", true],
])(
	"MESSAGE %j decodes without losing missing/truncated state",
	(raw, message, truncated) => {
		expect(parseRecord(journalObject({ MESSAGE: raw }))).toMatchObject({
			message,
			truncated,
		});
	},
);

test.each([
	["x".repeat(16_384), "x".repeat(16_384), false],
	["x".repeat(16_385), "x".repeat(16_384), true],
	["é".repeat(8193), "é".repeat(8192), true],
	[`${"x".repeat(16_383)}é`, "x".repeat(16_383), true],
])(
	"message byte boundary retains a nonempty prefix",
	(raw, message, truncated) => {
		expect(parseRecord(journalObject({ MESSAGE: raw }))).toMatchObject({
			message,
			truncated,
		});
	},
);

test.each([
	[
		{ ts: "x", msg: "saved", module: "camera", meta: { attempt: 2 } },
		'[camera] saved {"attempt":2}',
	],
	[{ ts: "x", msg: "saved" }, "saved"],
	[{ ts: "x", msg: "saved", module: "", meta: {} }, "saved {}"],
	[{ ts: "x", msg: "saved", module: 1, meta: null }, "saved"],
])(
	"structured logger entry renders module, msg and metadata",
	(obj, message) => {
		expect(
			parseRecord(journalObject({ MESSAGE: JSON.stringify(obj) }))?.message,
		).toBe(message);
	},
);

test.each([
	["error", "error"],
	["warn", "warning"],
	["info", "info"],
	["debug", "debug"],
	["warning", "info"],
	["unknown", "info"],
	[4, "info"],
	["constructor", "info"],
	["toString", "info"],
	["__proto__", "info"],
	[["warn"], "info"],
] as const)(
	"legacy logger level %j overrides journal info only for known levels",
	(level, expected) => {
		const MESSAGE = JSON.stringify({ ts: "x", msg: "legacy", level });
		expect(
			parseRecord(
				journalObject({ MESSAGE, PRIORITY: level === "info" ? "3" : "6" }),
			)?.level,
		).toBe(expected);
	},
);

test.each([
	'{"ts":broken',
	'{"ts":1,"msg":42}',
	'{"msg":"plain","ts":1}',
	' {"ts":1,"msg":"plain"}',
])("non-logger JSON or malformed text stays visible: %s", (MESSAGE) => {
	expect(parseRecord(journalObject({ MESSAGE }))?.message).toBe(MESSAGE);
});

const nativePriorities = [
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
	[-1, "info"],
	["-1", "info"],
	[NaN, "info"],
	[Infinity, "info"],
	["", "info"],
	[" ", "info"],
	["03", "info"],
	[" 3", "info"],
	["3 ", "info"],
	["3.0", "info"],
	["+3", "info"],
	["3e0", "info"],
	["-0", "info"],
	[-0, "error"],
	["INFO", "info"],
] as const;

for (const [PRIORITY, nativeLevel] of nativePriorities) {
	test(`native priority ${JSON.stringify(PRIORITY)} has level ${nativeLevel}`, () => {
		expect(parseRecord(journalObject({ PRIORITY }))?.level).toBe(nativeLevel);
	});
	test.each([
		["error", "error"],
		["warn", "warning"],
		["info", "info"],
		["debug", "debug"],
	] as const)(
		`legacy %s overrides native ${JSON.stringify(PRIORITY)}`,
		(level, expected) => {
			const MESSAGE = JSON.stringify({
				ts: "x",
				msg: "legacy override",
				level,
			});
			expect(parseRecord(journalObject({ MESSAGE, PRIORITY }))?.level).toBe(
				expected,
			);
		},
	);
}

test.each(
	[
		"warning",
		"INFO",
		"Error",
		" info",
		"info ",
		"",
		"constructor",
		"__proto__",
		null,
		undefined,
		6,
		["info"],
	].map((level) => ({ level })),
)("unsupported legacy level %j preserves native error", ({ level }) => {
	const MESSAGE = JSON.stringify({ ts: "x", msg: "legacy", level });
	expect(parseRecord(journalObject({ MESSAGE, PRIORITY: "3" }))?.level).toBe(
		"error",
	);
});

test("structured output receives the same byte cap after expansion", () => {
	const MESSAGE = JSON.stringify({
		ts: 1,
		msg: "x".repeat(20_000),
		module: "m",
	});
	expect(parseRecord(journalObject({ MESSAGE }))).toMatchObject({
		message: `[m] ${"x".repeat(16_380)}`,
		truncated: true,
	});
});

test("only the contracted synthetic notice id gets a marker; text is unproven on 257", () => {
	for (const id of [undefined, "other", "a596d6fe7bfa4994828e72309e95d61e"]) {
		expect(parseRecord(journalObject({ MESSAGE_ID: id }))?.marker).toBe(
			id === "a596d6fe7bfa4994828e72309e95d61e" ? "suppressed" : null,
		);
	}
});

test("unexpected structured decoder failures propagate instead of hiding a broken reader", () => {
	const error = new TypeError("decoder infrastructure failed");
	const decode = spyOn(JSON, "parse").mockImplementationOnce(() => {
		throw error;
	});
	try {
		expect(() =>
			parseRecord(journalObject({ MESSAGE: '{"ts":1,"msg":"x"}' })),
		).toThrow(error);
	} finally {
		decode.mockRestore();
	}
});
