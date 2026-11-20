import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
import {
	getLogSettings,
	getLogState,
	initLogSettings,
	saveLogSettings,
	setLogSettingsDirForTest,
	updateLogState,
} from "../modules/device-logs/settings.ts";

const defaults = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;
const initialState = {
	historyEpoch: 0,
	lastClearedAt: null,
	lastMaintenance: null,
};
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ceraui-device-logs-state-"));
	setLogSettingsDirForTest(dir);
});

afterEach(() => {
	setLogSettingsDirForTest(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("device log state persistence", () => {
	test("uses defaults without creating a state file when absent", () => {
		expect(getLogState()).toEqual(initialState);
		expect(existsSync(join(dir, "log-state.json"))).toBe(false);
	});

	test("persists valid patches while retaining fields omitted from a patch", () => {
		updateLogState({
			historyEpoch: 2,
			lastClearedAt: 1234,
			lastMaintenance: { at: 2345, ok: false, targetMet: false },
		});
		const updated = updateLogState({ historyEpoch: 3 });

		const expected = {
			historyEpoch: 3,
			lastClearedAt: 1234,
			lastMaintenance: { at: 2345, ok: false, targetMet: false },
		};
		expect(updated).toEqual(expected);
		expect(getLogState()).toEqual(expected);
		expect(
			JSON.parse(readFileSync(join(dir, "log-state.json"), "utf8")),
		).toEqual(getLogState());
	});

	test("returned state cannot mutate the cached state", () => {
		const updated = updateLogState({
			historyEpoch: 2,
			lastMaintenance: { at: 1, ok: true, targetMet: true },
		});
		updated.historyEpoch = 3;
		if (updated.lastMaintenance) updated.lastMaintenance.ok = false;
		expect(getLogState().historyEpoch).toBe(2);
		expect(getLogState().lastMaintenance?.ok).toBe(true);

		const readState = getLogState();
		readState.historyEpoch = 4;
		if (readState.lastMaintenance) readState.lastMaintenance.ok = false;
		expect(getLogState().historyEpoch).toBe(2);
		expect(getLogState().lastMaintenance?.ok).toBe(true);
	});

	test("accepts zero timestamps and nullable state values", () => {
		updateLogState({
			historyEpoch: 0,
			lastClearedAt: 0,
			lastMaintenance: { at: 0, ok: true, targetMet: false },
		});
		expect(getLogState()).toEqual({
			historyEpoch: 0,
			lastClearedAt: 0,
			lastMaintenance: { at: 0, ok: true, targetMet: false },
		});
		updateLogState({ lastClearedAt: null, lastMaintenance: null });
		expect(getLogState()).toEqual(initialState);
	});

	test("loads a saved state again after reinitialization", () => {
		updateLogState({ historyEpoch: 2 });
		initLogSettings();

		expect(getLogState()).toEqual({
			...initialState,
			historyEpoch: 2,
		});
		writeFileSync(
			join(dir, "log-state.json"),
			JSON.stringify({ ...initialState, historyEpoch: 4 }),
		);
		expect(getLogState().historyEpoch).toBe(2);
		initLogSettings();
		expect(getLogState().historyEpoch).toBe(4);
	});

	test("init caches a cold-loaded state before later reads", () => {
		const savedState = { ...initialState, historyEpoch: 3 };
		writeFileSync(join(dir, "log-state.json"), JSON.stringify(savedState));
		initLogSettings();
		writeFileSync(
			join(dir, "log-state.json"),
			JSON.stringify({ ...savedState, historyEpoch: 9 }),
		);

		expect(getLogState()).toEqual(savedState);
	});

	test("switching injected directories reloads the state cache", () => {
		updateLogState({ historyEpoch: 2 });
		const otherDir = mkdtempSync(
			join(tmpdir(), "ceraui-device-log-state-next-"),
		);
		const otherState = { ...initialState, historyEpoch: 4 };
		try {
			writeFileSync(
				join(otherDir, "log-state.json"),
				JSON.stringify(otherState),
			);
			setLogSettingsDirForTest(otherDir);
			expect(getLogState()).toEqual(otherState);
		} finally {
			setLogSettingsDirForTest(dir);
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test.each([
		{ historyEpoch: -1 },
		{ historyEpoch: 1.5 },
		{ lastClearedAt: -1 },
		{ lastClearedAt: 1.5 },
		{ lastMaintenance: { at: 1.5, ok: true, targetMet: false } },
		{ lastMaintenance: { at: 1, ok: "yes", targetMet: false } },
		{ lastMaintenance: { at: 1, ok: true, targetMet: "no" } },
		{ lastMaintenance: { at: 1, ok: true } },
		{ lastMaintenance: { at: 1, ok: true, targetMet: false, extra: true } },
		{ unknown: true },
	])("rejects invalid state patches without writing: %j", (patch) => {
		const write = spyOn(configLoader, "writeFileAtomicSync");
		try {
			expect(() => updateLogState(JSON.parse(JSON.stringify(patch)))).toThrow();
			expect(write).not.toHaveBeenCalled();
			expect(getLogState()).toEqual(initialState);
		} finally {
			write.mockRestore();
		}
	});

	test("invalid state JSON falls back without modifying its bytes", () => {
		const file = join(dir, "log-state.json");
		const corrupt = '{"historyEpoch":1';
		writeFileSync(file, corrupt);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(getLogState()).toEqual(initialState);
			expect(getLogState()).toEqual(initialState);
			expect(readFileSync(file, "utf8")).toBe(corrupt);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("out-of-range state JSON falls back without modifying its bytes", () => {
		const file = join(dir, "log-state.json");
		const raw = JSON.stringify({ ...initialState, historyEpoch: -1 });
		writeFileSync(file, raw);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			expect(getLogState()).toEqual(initialState);
			expect(readFileSync(file, "utf8")).toBe(raw);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("unreadable settings files warn and use defaults without writing", () => {
		const file = join(dir, "log-settings.json");
		mkdirSync(file);
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		try {
			initLogSettings();
			expect(getLogSettings()).toEqual(defaults);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
			rmSync(file, { recursive: true, force: true });
		}
	});

	test("failed atomic state writes do not publish an in-memory change", () => {
		const fail = spyOn(configLoader, "writeFileAtomicSync").mockImplementation(
			() => {
				throw new Error("disk unavailable");
			},
		);
		try {
			expect(() => updateLogState({ historyEpoch: 1 })).toThrow(
				"disk unavailable",
			);
			expect(getLogState()).toEqual(initialState);
		} finally {
			fail.mockRestore();
		}
	});

	test("failed settings writes do not publish an in-memory change", () => {
		saveLogSettings(defaults);
		const fail = spyOn(configLoader, "writeFileAtomicSync").mockImplementation(
			() => {
				throw new Error("disk unavailable");
			},
		);
		try {
			expect(() =>
				saveLogSettings({ maxAgeDays: 7, maxSizeMb: 32, detail: "info" }),
			).toThrow("disk unavailable");
			expect(getLogSettings()).toEqual(defaults);
		} finally {
			fail.mockRestore();
		}
	});
});
