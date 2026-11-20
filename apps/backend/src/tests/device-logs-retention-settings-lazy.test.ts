import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";

test("initial lazy getters load persisted history and limits before any initializer or test setter", async () => {
	const previous = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), "ceraui-history-lazy-"));
	const limits = { maxAgeDays: 7, maxSizeMb: 64, detail: "info" as const };
	const history = {
		historyEpoch: 19,
		lastClearedAt: 123,
		lastMaintenance: null,
	};
	try {
		writeFileSync(join(dir, "log-settings.json"), JSON.stringify(limits));
		writeFileSync(join(dir, "log-state.json"), JSON.stringify(history));
		process.chdir(dir);
		const settings = await import("../modules/device-logs/settings.ts");
		expect(settings.getLogSettings()).toEqual(limits);
		expect(settings.getLogState()).toEqual(history);
	} finally {
		process.chdir(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an explicitly empty settings directory keeps relative failure paths in the real log", async () => {
	const previous = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), "ceraui-history-relative-"));
	const settings = await import("../modules/device-logs/settings.ts");
	try {
		mkdirSync(join(dir, "log-settings.json"));
		process.chdir(dir);
		settings.setLogSettingsDirForTest("");
		clearRecentLogLines();
		expect(settings.getLogSettings()).toEqual({
			maxAgeDays: null,
			maxSizeMb: null,
			detail: "debug",
		});
		expect(getRecentLogLines().map((line) => JSON.parse(line).msg)).toEqual([
			"Failed to read log settings file: log-settings.json",
		]);
	} finally {
		settings.setLogSettingsDirForTest(null);
		clearRecentLogLines();
		process.chdir(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed persisted JSON records the exact invalid-file warning through the real logger", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-history-invalid-"));
	const settings = await import("../modules/device-logs/settings.ts");
	try {
		writeFileSync(join(dir, "log-settings.json"), "{");
		settings.setLogSettingsDirForTest(dir);
		clearRecentLogLines();
		expect(settings.getLogSettings()).toEqual({
			maxAgeDays: null,
			maxSizeMb: null,
			detail: "debug",
		});
		expect(getRecentLogLines().map((line) => JSON.parse(line).msg)).toEqual([
			`Invalid log settings file: ${join(dir, "log-settings.json")}`,
		]);
	} finally {
		settings.setLogSettingsDirForTest(null);
		clearRecentLogLines();
		rmSync(dir, { recursive: true, force: true });
	}
});
