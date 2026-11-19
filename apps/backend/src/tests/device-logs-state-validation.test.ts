import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
import {
	getLogState,
	setLogSettingsDirForTest,
	updateLogState,
} from "../modules/device-logs/settings.ts";

const initial = {
	historyEpoch: 0,
	lastClearedAt: null,
	lastMaintenance: null,
};
const invalidStoredStates = [
	{
		name: "negative maintenance timestamp",
		value: {
			historyEpoch: 3,
			lastClearedAt: 5,
			lastMaintenance: { at: -1, ok: true, targetMet: false },
		},
	},
	{
		name: "missing nullable clear timestamp",
		value: { historyEpoch: 3, lastMaintenance: null },
	},
	{
		name: "missing nullable maintenance record",
		value: { historyEpoch: 3, lastClearedAt: 5 },
	},
	{
		name: "missing maintenance result boolean",
		value: {
			historyEpoch: 3,
			lastClearedAt: 5,
			lastMaintenance: { at: 6, targetMet: false },
		},
	},
	{
		name: "missing maintenance timestamp",
		value: {
			historyEpoch: 3,
			lastClearedAt: 5,
			lastMaintenance: { ok: true, targetMet: false },
		},
	},
];
const validState = {
	historyEpoch: 3,
	lastClearedAt: 5,
	lastMaintenance: { at: 6, ok: true, targetMet: false },
};
const wrongTypes = [
	["numeric string", "6"],
	["empty string", ""],
	["true", true],
	["false", false],
	["object", {}],
	["array", []],
	["missing", undefined],
] as const;
const invalidNumbers = [
	...wrongTypes,
	["negative", -1],
	["fraction", 0.5],
	["NaN", Number.NaN],
	["infinity", Number.POSITIVE_INFINITY],
	["negative infinity", Number.NEGATIVE_INFINITY],
	["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
	["huge number", Number.MAX_VALUE],
] as const;
const numericFields = ["historyEpoch", "lastClearedAt", "at"] as const;
const invalidFields = [
	...numericFields.flatMap((field) =>
		[
			...invalidNumbers,
			...(field === "lastClearedAt" ? [] : ([["null", null]] as const)),
		].map(([name, value]) => ({
			name: `${field} ${name}`,
			patch: Object.fromEntries([
				field === "at"
					? ["lastMaintenance", { ...validState.lastMaintenance, at: value }]
					: [field, value],
			]),
		})),
	),
	...(["ok", "targetMet"] as const).flatMap((field) =>
		[
			...wrongTypes.filter(([, value]) => typeof value !== "boolean"),
			["false string", "false"],
			["zero", 0],
			["one", 1],
			["null", null],
		].map(([name, value]) => ({
			name: `${field} ${name}`,
			patch: {
				lastMaintenance: { ...validState.lastMaintenance, [field]: value },
			},
		})),
	),
	...[
		["string", "null"],
		["boolean", false],
		["number", 0],
		["array", []],
		["missing", undefined],
		["unknown nested key", { ...validState.lastMaintenance, extra: true }],
	].map(([name, value]) => ({
		name: `lastMaintenance ${name}`,
		patch: Object.fromEntries([["lastMaintenance", value]]),
	})),
];
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ceraui-log-state-validation-"));
	setLogSettingsDirForTest(dir);
});

afterEach(() => {
	setLogSettingsDirForTest(null);
	rmSync(dir, { recursive: true, force: true });
});

test.each(invalidStoredStates)(
	"$name on disk defaults and preserves the stored bytes",
	({ value }) => {
		const path = join(dir, "log-state.json");
		const raw = JSON.stringify(value);
		writeFileSync(path, raw);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(getLogState()).toEqual(initial);
			expect(readFileSync(path, "utf8")).toBe(raw);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	},
);

test.each(invalidFields)(
	"$name is rejected on update without changing bytes or cache",
	({ patch }) => {
		updateLogState(validState);
		const path = join(dir, "log-state.json");
		const before = readFileSync(path);
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			expect(() => updateLogState(patch)).toThrow();
			expect(write).not.toHaveBeenCalled();
			expect(readFileSync(path)).toEqual(before);
			expect(getLogState()).toEqual(validState);
		} finally {
			write.mockRestore();
		}
	},
);

test.each(invalidFields)(
	"$name on disk defaults once and preserves bytes",
	({ patch }) => {
		const path = join(dir, "log-state.json");
		// Overflow remains a number on JSON.parse, unlike stringify(NaN/Infinity).
		const raw = JSON.stringify({ ...validState, ...patch }, (_key, value) =>
			typeof value === "number" && !Number.isFinite(value)
				? "__nonfinite__"
				: value,
		).replaceAll('"__nonfinite__"', "1e999");
		writeFileSync(path, raw);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(getLogState()).toEqual(initial);
			expect(getLogState()).toEqual(initial);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(readFileSync(path, "utf8")).toBe(raw);
		} finally {
			warn.mockRestore();
		}
	},
);

const stateJson = JSON.stringify(validState);
test.each([
	["UTF-8", Buffer.from(stateJson), 0],
	["UTF-8 BOM", Buffer.from(`\uFEFF${stateJson}`), 1],
	["trailing UTF-8 BOM", Buffer.from(`${stateJson}\uFEFF`), 1],
	["UTF-16 LE BOM", Buffer.from(`\uFEFF${stateJson}`, "utf16le"), 1],
	["UTF-16 BE BOM", Buffer.from(`\uFEFF${stateJson}`, "utf16le").swap16(), 1],
	["leading spaces", Buffer.from(`  ${stateJson}`), 0],
	["trailing spaces", Buffer.from(`${stateJson}  `), 0],
	["leading newline", Buffer.from(`\n${stateJson}`), 0],
	["trailing newline", Buffer.from(`${stateJson}\n`), 0],
	["surrounding JSON whitespace", Buffer.from(` \t\r\n${stateJson}\r\n\t `), 0],
	["non-JSON whitespace", Buffer.from(`\u00A0${stateJson}\u00A0`), 1],
	["form feed", Buffer.from(`\f${stateJson}\f`), 1],
	["NUL only", Buffer.from("\0"), 1],
	["leading NUL", Buffer.from(`\0${stateJson}`), 1],
	["trailing NUL", Buffer.from(`${stateJson}\0`), 1],
	[
		"embedded NUL",
		Buffer.from(`${stateJson.slice(0, 1)}\0${stateJson.slice(1)}`),
		1,
	],
	[
		"space inside property name",
		Buffer.from(stateJson.replace('":', ' ":')),
		1,
	],
	[
		"newline inside property name",
		Buffer.from(stateJson.replace('":', '\n":')),
		1,
	],
	[
		"escaped ASCII property name",
		Buffer.from(stateJson.replace("historyEpoch", "\\u0068istoryEpoch")),
		0,
	],
] as const)(
	"%s state decoding preserves bytes with the expected warning count",
	(_name, bytes, warnings) => {
		const path = join(dir, "log-state.json");
		writeFileSync(path, bytes);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			const expected = warnings === 0 ? validState : initial;
			expect(getLogState()).toEqual(expected);
			expect(getLogState()).toEqual(expected);
			expect(warn).toHaveBeenCalledTimes(warnings);
			expect(readFileSync(path)).toEqual(bytes);
		} finally {
			warn.mockRestore();
		}
	},
);

test.each(
	numericFields.flatMap((field) =>
		[-0, 0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER].map(
			(value) => ({ field, value }),
		),
	),
)("$field accepts safe integer boundary $value", ({ field, value }) => {
	const expected =
		field === "at"
			? {
					...validState,
					lastMaintenance: { ...validState.lastMaintenance, at: value },
				}
			: { ...validState, [field]: value };
	expect(updateLogState(expected)).toEqual(expected);
	setLogSettingsDirForTest(dir);
	expect(getLogState()).toEqual(JSON.parse(JSON.stringify(expected)));
});

test.each([null, [], "state", 0, true].map((value) => ({ value })))(
	"non-record state %j defaults on disk and rejects as a patch",
	({ value }) => {
		const raw = JSON.stringify(value);
		const path = join(dir, "log-state.json");
		writeFileSync(path, raw);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			expect(getLogState()).toEqual(initial);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(() => updateLogState(JSON.parse(raw))).toThrow();
			expect(write).not.toHaveBeenCalled();
			expect(readFileSync(path, "utf8")).toBe(raw);
		} finally {
			warn.mockRestore();
			write.mockRestore();
		}
	},
);

test("a successful update stays cached after later disk corruption", () => {
	updateLogState(validState);
	writeFileSync(join(dir, "log-state.json"), "{");
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		expect(getLogState()).toEqual(validState);
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});

test("one state update commits through exactly one atomic write", () => {
	const write = spyOn(configLoader, "writeFileAtomicSync");
	try {
		expect(updateLogState(validState)).toEqual(validState);
		expect(write).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(readFileSync(join(dir, "log-state.json"), "utf8")),
		).toEqual(validState);
	} finally {
		write.mockRestore();
	}
});

test("null state patches reject before writing", () => {
	const write = spyOn(configLoader, "writeFileAtomicSync");
	try {
		expect(() => updateLogState(JSON.parse("null"))).toThrow();
		expect(write).not.toHaveBeenCalled();
		expect(getLogState()).toEqual(initial);
	} finally {
		write.mockRestore();
	}
});

test("an explicitly undefined required field rejects before writing", () => {
	const patch = Object.defineProperty({}, "historyEpoch", {
		value: undefined,
		enumerable: true,
	});
	const write = spyOn(configLoader, "writeFileAtomicSync");
	try {
		expect(() => updateLogState(patch)).toThrow();
		expect(write).not.toHaveBeenCalled();
		expect(getLogState()).toEqual(initial);
	} finally {
		write.mockRestore();
	}
});
