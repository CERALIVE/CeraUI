import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import * as logging from "../helpers/logger.ts";
import { logger } from "../helpers/logger.ts";
import {
	getLogSettings,
	initLogSettings,
	saveLogSettings,
	setLogSettingsDirForTest,
} from "../modules/device-logs/settings.ts";

const defaults = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ceraui-device-logs-settings-"));
	setLogSettingsDirForTest(dir);
});

afterEach(() => {
	setLogSettingsDirForTest(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("device log settings persistence", () => {
	test("uses defaults without creating either file when absent", () => {
		const setDetail = spyOn(logging, "setJournalDetail");
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		initLogSettings();

		try {
			expect(getLogSettings()).toEqual(defaults);
			expect(setDetail).toHaveBeenCalledTimes(1);
			expect(setDetail).toHaveBeenCalledWith("debug");
			expect(warn).not.toHaveBeenCalled();
			expect(existsSync(join(dir, "log-settings.json"))).toBe(false);
			expect(existsSync(join(dir, "log-state.json"))).toBe(false);
		} finally {
			setDetail.mockRestore();
			warn.mockRestore();
		}
	});

	test("accepts the minimum retention bounds", () => {
		expect(
			saveLogSettings({ maxAgeDays: 1, maxSizeMb: 16, detail: "info" }),
		).toEqual({
			maxAgeDays: 1,
			maxSizeMb: 16,
			detail: "info",
		});
	});

	test("returned settings cannot mutate the settings cache", () => {
		const savedSettings = saveLogSettings({
			maxAgeDays: null,
			maxSizeMb: null,
			detail: "info",
		});
		savedSettings.detail = "debug";
		expect(getLogSettings().detail).toBe("info");
		const readSettings = getLogSettings();
		readSettings.detail = "debug";
		expect(getLogSettings().detail).toBe("info");
	});

	test("persists settings atomically and reloads them on init", () => {
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			const saved = saveLogSettings({
				maxAgeDays: 14,
				maxSizeMb: 64,
				detail: "info",
			});

			expect(saved).toEqual({
				maxAgeDays: 14,
				maxSizeMb: 64,
				detail: "info",
			});
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[0]).toBe(join(dir, "log-settings.json"));
			expect(
				JSON.parse(readFileSync(join(dir, "log-settings.json"), "utf8")),
			).toEqual(saved);

			initLogSettings();
			expect(getLogSettings()).toEqual(saved);
			writeFileSync(
				join(dir, "log-settings.json"),
				JSON.stringify({ ...saved, maxAgeDays: 7 }),
			);
			expect(getLogSettings()).toEqual(saved);
			initLogSettings();
			expect(getLogSettings()).toEqual({ ...saved, maxAgeDays: 7 });
		} finally {
			write.mockRestore();
		}
	});

	test("uses the process working directory when no test directory is injected", () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(dir);
			setLogSettingsDirForTest(null);
			saveLogSettings(defaults);
			expect(existsSync(join(dir, "log-settings.json"))).toBe(true);
		} finally {
			process.chdir(originalCwd);
			setLogSettingsDirForTest(dir);
		}
	});

	test("switching injected directories reloads the settings cache", () => {
		saveLogSettings({ maxAgeDays: 7, maxSizeMb: 32, detail: "info" });
		const otherDir = mkdtempSync(
			join(tmpdir(), "ceraui-device-logs-settings-next-"),
		);
		const otherSettings = {
			maxAgeDays: 21,
			maxSizeMb: 48,
			detail: "info",
		} as const;
		try {
			writeFileSync(
				join(otherDir, "log-settings.json"),
				JSON.stringify(otherSettings),
			);
			setLogSettingsDirForTest(otherDir);
			expect(getLogSettings()).toEqual(otherSettings);
		} finally {
			setLogSettingsDirForTest(dir);
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test.each([
		{ maxAgeDays: 0, maxSizeMb: null, detail: "debug" },
		{ maxAgeDays: null, maxSizeMb: 15, detail: "debug" },
		{ maxAgeDays: null, maxSizeMb: null, detail: "trace" },
		{ maxAgeDays: 1.5, maxSizeMb: null, detail: "debug" },
		{ maxAgeDays: null, maxSizeMb: null, detail: "debug", extra: true },
	])("rejects invalid settings input without writing: %j", (value) => {
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			expect(() => saveLogSettings(value)).toThrow();
			expect(write).not.toHaveBeenCalled();
			expect(getLogSettings()).toEqual(defaults);
		} finally {
			write.mockRestore();
		}
	});

	test("invalid JSON falls back to defaults and preserves the original bytes", () => {
		const file = join(dir, "log-settings.json");
		const corrupt = '{"detail":';
		writeFileSync(file, corrupt);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			initLogSettings();
			expect(getLogSettings()).toEqual(defaults);
			expect(readFileSync(file, "utf8")).toBe(corrupt);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test.each([
		{ maxAgeDays: 0, maxSizeMb: null, detail: "debug" },
		{ maxAgeDays: null, maxSizeMb: 15, detail: "debug" },
		{ maxAgeDays: null, maxSizeMb: null, detail: "trace" },
		{ maxAgeDays: null, maxSizeMb: null, detail: "debug", extra: true },
	])(
		"invalid persisted settings use defaults without rewriting the file: %j",
		(value) => {
			const file = join(dir, "log-settings.json");
			const raw = JSON.stringify(value);
			writeFileSync(file, raw);
			const warn = spyOn(logger, "warn").mockImplementation(() => logger);
			try {
				initLogSettings();
				expect(getLogSettings()).toEqual(defaults);
				expect(readFileSync(file, "utf8")).toBe(raw);
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		},
	);

	test("init applies persisted detail to the journal logger", () => {
		writeFileSync(
			join(dir, "log-settings.json"),
			JSON.stringify({ ...defaults, detail: "info" }),
		);
		const setDetail = spyOn(logging, "setJournalDetail");
		try {
			initLogSettings();
			expect(setDetail).toHaveBeenCalledTimes(1);
			expect(setDetail).toHaveBeenCalledWith("info");
		} finally {
			setDetail.mockRestore();
		}
	});
});
