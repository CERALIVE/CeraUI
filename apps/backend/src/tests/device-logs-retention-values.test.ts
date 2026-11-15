import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
	["256M", "1month", 256, 30],
	["16384K", "2weeks", 16, 14],
	["1G", "1209600", 1024, 14],
	["17M", "86400s", 17, 1],
	["17M", "1440min", 17, 1],
	["17M", "48h", 17, 2],
	["17M", "3d", 17, 3],
	["17M", "3day", 17, 3],
	["17M", "3days", 17, 3],
	["17M", "1w", 17, 7],
	["17M", "1week", 17, 7],
	["17M", "2months", 17, 60],
	["17M", "1y", 17, 365],
	["17M", "1year", 17, 365],
	["17408K", "172799s", 17, 1],
	["1M", "1d", 1, 1],
	...[
		["min", 60],
		["h", 3600],
		["d", 86400],
		["day", 86400],
		["days", 86400],
		["w", 604800],
		["week", 604800],
		["weeks", 604800],
		["month", 2629800],
		["months", 2629800],
		["y", 31557600],
		["year", 31557600],
	].map(([unit, days]) => ["256M", `86400${unit}`, 256, Number(days)] as const),
])("reads image ceiling %s / %s", async (size, age, maxSizeMb, maxAgeDays) => {
	const { readJournalCeiling } = await import(
		"../modules/device-logs/ceiling.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-ceiling-"));
	try {
		writeFileSync(
			join(dir, "conf"),
			`# ignored\n[Journal]\nSystemMaxUse=${size}\nMaxRetentionSec=${age}\n`,
		);
		expect(readJournalCeiling(join(dir, "conf"))).toEqual({
			maxSizeMb,
			maxAgeDays,
		});
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test.each([
	"",
	"# SystemMaxUse=256M\n# MaxRetentionSec=1month",
	"SystemMaxUse=256M",
	"MaxRetentionSec=1month",
	"SystemMaxUse=0M\nMaxRetentionSec=1d",
	"SystemMaxUse=1K\nMaxRetentionSec=1d",
	"SystemMaxUse=1.5M\nMaxRetentionSec=1d",
	"SystemMaxUse=-1G\nMaxRetentionSec=1d",
	"SystemMaxUse=256T\nMaxRetentionSec=1d",
	"SystemMaxUse=256M\nMaxRetentionSec=0",
	"SystemMaxUse=256M\nMaxRetentionSec=86399s",
	"SystemMaxUse=256M\nMaxRetentionSec=-1d",
	"SystemMaxUse=256M\nMaxRetentionSec=Infinity",
	"SystemMaxUse=256M\nMaxRetentionSec=1.5d",
	"SystemMaxUse=999999999999999999999999999G\nMaxRetentionSec=1d",
	"SystemMaxUse=256M\nMaxRetentionSec=9007199254740991y",
	"SystemMaxUse=256M\nMaxRetentionSec=1day trailing",
	"[Other]\nSystemMaxUse=256M\nMaxRetentionSec=1d",
])("keeps malformed image ceiling unknown: %s", async (text) => {
	const { readJournalCeiling } = await import(
		"../modules/device-logs/ceiling.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "retention-ceiling-"));
	try {
		writeFileSync(join(dir, "conf"), `[Journal]\n${text}`);
		expect(readJournalCeiling(join(dir, "conf"))).toBeNull();
		expect(readJournalCeiling(join(dir, "missing"))).toBeNull();
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("settings outside a journal section cannot establish the image ceiling", async () => {
	const { readJournalCeiling } = await import(
		"../modules/device-logs/ceiling.ts"
	);
	const read = spyOn(fs, "readFileSync").mockReturnValue(
		"SystemMaxUse=256M\nMaxRetentionSec=1d\n",
	);
	try {
		expect(readJournalCeiling()).toBeNull();
	} finally {
		read.mockRestore();
	}
});

test.each([
	["Archived and active journals take up 1.5M in the file system.", 1572864],
	["take up 3 B", 3],
	["take up 2K", 2048],
	["take up 1G", 1073741824],
	["take up 1T", 1099511627776],
	["take up 0B", 0],
	["No journal files were found.", null],
	["take up -1M", null],
	["take up .M", null],
	["take up 1..2M", null],
	["take up 999999999999999999999T", null],
	["take up 9007199254740991 B", Number.MAX_SAFE_INTEGER],
])("parses observed disk usage %s", async (text, expected) => {
	const { parseDiskUsage } = await import("../modules/device-logs/ceiling.ts");
	expect(parseDiskUsage(text)).toBe(expected);
});

test("reads only the image-owned default drop-in and respects journal sections", async () => {
	const { readJournalCeiling } = await import(
		"../modules/device-logs/ceiling.ts"
	);
	const read = spyOn(fs, "readFileSync").mockReturnValue(
		"[Other]\nSystemMaxUse=1G\n[Journal]\nSystemMaxUse = 256M\nMaxRetentionSec = 2weeks\n[Other]\nSystemMaxUse=1G\n",
	);
	try {
		expect(readJournalCeiling()).toEqual({ maxSizeMb: 256, maxAgeDays: 14 });
		expect(read).toHaveBeenCalledWith(
			"/etc/systemd/journald.conf.d/10-ceralive-journal.conf",
			"utf8",
		);
	} finally {
		read.mockRestore();
	}
});
