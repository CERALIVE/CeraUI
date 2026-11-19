import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
import {
	getLogSettings,
	saveLogSettings,
	setLogSettingsDirForTest,
} from "../modules/device-logs/settings.ts";
import { expectInvalidRetention } from "./helpers/retention-rpc.ts";

const defaults = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;
const saved = { maxAgeDays: 7, maxSizeMb: 32, detail: "info" } as const;
const wrongTypes = [
	["numeric string", "32"],
	["empty string", ""],
	["true", true],
	["false", false],
	["object", {}],
	["array", []],
	["missing", undefined],
] as const;
const invalidSettings = [
	...(["maxAgeDays", "maxSizeMb"] as const).flatMap((field) =>
		[
			...wrongTypes,
			["negative zero", -0],
			["negative", -1],
			["below minimum", field === "maxAgeDays" ? 0 : 15],
			["fraction", field === "maxAgeDays" ? 1.5 : 16.5],
			["NaN", Number.NaN],
			["infinity", Number.POSITIVE_INFINITY],
			["negative infinity", Number.NEGATIVE_INFINITY],
			["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
			["huge number", Number.MAX_VALUE],
		].map(([name, value]) => ({
			name: `${field} ${name}`,
			value: { ...saved, [field]: value },
		})),
	),
	...[
		...wrongTypes,
		["null", null],
		["number", 0],
		["unsupported level", "trace"],
		["case mismatch", "INFO"],
	].map(([name, value]) => ({
		name: `detail ${name}`,
		value: { ...saved, detail: value },
	})),
	...[
		["null record", null],
		["array record", []],
		["string record", "settings"],
		["number record", 0],
		["boolean record", true],
		["unknown field", { ...saved, extra: true }],
	].map(([name, value]) => ({ name, value })),
];
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ceraui-log-settings-boundary-"));
	setLogSettingsDirForTest(dir);
});

afterEach(() => {
	setLogSettingsDirForTest(null);
	rmSync(dir, { recursive: true, force: true });
});

test.each(invalidSettings)(
	"$name RPC settings input rejects without changing bytes or cache",
	async ({ value }) => {
		saveLogSettings(saved);
		const path = join(dir, "log-settings.json");
		const before = readFileSync(path);
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			await expectInvalidRetention(value);
			expect(write).not.toHaveBeenCalled();
			expect(readFileSync(path)).toEqual(before);
			expect(getLogSettings()).toEqual(saved);
		} finally {
			write.mockRestore();
		}
	},
);

test.each(invalidSettings)(
	"$name persisted settings default once and preserve bytes",
	({ value }) => {
		const raw = JSON.stringify(value, (_key, item) =>
			typeof item === "number" && !Number.isFinite(item)
				? "__nonfinite__"
				: item,
		).replaceAll('"__nonfinite__"', "1e999");
		const path = join(dir, "log-settings.json");
		writeFileSync(path, raw);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(getLogSettings()).toEqual(defaults);
			expect(getLogSettings()).toEqual(defaults);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(readFileSync(path, "utf8")).toBe(raw);
		} finally {
			warn.mockRestore();
		}
	},
);

const settingsJson = JSON.stringify(saved);
test.each([
	["UTF-8", Buffer.from(settingsJson), 0],
	["UTF-8 BOM", Buffer.from(`\uFEFF${settingsJson}`), 1],
	["trailing UTF-8 BOM", Buffer.from(`${settingsJson}\uFEFF`), 1],
	["UTF-16 LE BOM", Buffer.from(`\uFEFF${settingsJson}`, "utf16le"), 1],
	[
		"UTF-16 BE BOM",
		Buffer.from(`\uFEFF${settingsJson}`, "utf16le").swap16(),
		1,
	],
	["leading spaces", Buffer.from(`  ${settingsJson}`), 0],
	["trailing spaces", Buffer.from(`${settingsJson}  `), 0],
	["leading newline", Buffer.from(`\n${settingsJson}`), 0],
	["trailing newline", Buffer.from(`${settingsJson}\n`), 0],
	[
		"surrounding JSON whitespace",
		Buffer.from(` \t\r\n${settingsJson}\r\n\t `),
		0,
	],
	["non-JSON whitespace", Buffer.from(`\u00A0${settingsJson}\u00A0`), 1],
	["form feed", Buffer.from(`\f${settingsJson}\f`), 1],
	["NUL only", Buffer.from("\0"), 1],
	["leading NUL", Buffer.from(`\0${settingsJson}`), 1],
	["trailing NUL", Buffer.from(`${settingsJson}\0`), 1],
	[
		"embedded NUL",
		Buffer.from(`${settingsJson.slice(0, 1)}\0${settingsJson.slice(1)}`),
		1,
	],
	[
		"space inside property name",
		Buffer.from(settingsJson.replace('":', ' ":')),
		1,
	],
	[
		"newline inside property name",
		Buffer.from(settingsJson.replace('":', '\n":')),
		1,
	],
	[
		"escaped ASCII property name",
		Buffer.from(settingsJson.replace("maxAgeDays", "\\u006daxAgeDays")),
		0,
	],
] as const)(
	"%s settings decoding preserves bytes with the expected warning count",
	(_name, bytes, warnings) => {
		const path = join(dir, "log-settings.json");
		writeFileSync(path, bytes);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			const expected = warnings === 0 ? saved : defaults;
			expect(getLogSettings()).toEqual(expected);
			expect(getLogSettings()).toEqual(expected);
			expect(warn).toHaveBeenCalledTimes(warnings);
			expect(readFileSync(path)).toEqual(bytes);
		} finally {
			warn.mockRestore();
		}
	},
);

test.each([
	{ maxAgeDays: 1, maxSizeMb: 16, detail: "debug" },
	{ maxAgeDays: 2, maxSizeMb: 17, detail: "info" },
	{
		maxAgeDays: Number.MAX_SAFE_INTEGER - 1,
		maxSizeMb: Number.MAX_SAFE_INTEGER - 1,
		detail: "debug",
	},
	{
		maxAgeDays: Number.MAX_SAFE_INTEGER,
		maxSizeMb: Number.MAX_SAFE_INTEGER,
		detail: "info",
	},
	{ maxAgeDays: null, maxSizeMb: null, detail: "info" },
] as const)("safe settings bounds survive reload: %j", (value) => {
	expect(saveLogSettings(value)).toEqual(value);
	setLogSettingsDirForTest(dir);
	expect(getLogSettings()).toEqual(value);
});

test("cold invalid settings getters cache one warned fallback", () => {
	writeFileSync(join(dir, "log-settings.json"), '{"detail":');
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		expect(getLogSettings()).toEqual(defaults);
		expect(getLogSettings()).toEqual(defaults);
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		warn.mockRestore();
	}
});
test("a saved settings value remains cached if disk bytes later corrupt", () => {
	saveLogSettings(saved);
	writeFileSync(join(dir, "log-settings.json"), '{"detail":');
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		expect(getLogSettings()).toEqual(saved);
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});
test("high-bit bytes are malformed UTF-8 settings, not ASCII JSON", () => {
	const path = join(dir, "log-settings.json");
	const bytes = Buffer.from(
		[...Buffer.from(JSON.stringify(saved), "utf8")].map((byte) => byte | 0x80),
	);
	writeFileSync(path, bytes);
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		expect(getLogSettings()).toEqual(defaults);
		expect(readFileSync(path)).toEqual(bytes);
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		warn.mockRestore();
	}
});
