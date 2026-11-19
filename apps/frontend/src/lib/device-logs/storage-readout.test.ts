import { describe, expect, it } from "vitest";

import { logStorage } from "../../main/system-logs/__fixtures__/log-storage";
import {
	betweenWords,
	keepWhole,
	onDiskTotal,
	parseStorage,
	usageReadout,
	volumeRows,
} from "./storage-readout";

const MIB = 1024 * 1024;
const ceiling = { maxAgeDays: 30, maxSizeMb: 256 };
const deviceLimit = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;

describe("usageReadout", () => {
	it("measures the journal against the device's own limit", () => {
		expect(
			usageReadout({
				journalBytes: 64 * MIB,
				ceiling,
				retention: deviceLimit,
			}),
		).toEqual({ used: 64 * MIB, limit: 256 * MIB, percent: 25 });
	});

	it("measures against the user's tighter size limit", () => {
		expect(
			usageReadout({
				journalBytes: 16 * MIB,
				ceiling,
				retention: { ...deviceLimit, maxSizeMb: 64 },
			}),
		).toEqual({ used: 16 * MIB, limit: 64 * MIB, percent: 25 });
	});

	it("uses the device limit when a saved limit no longer fits the ceiling", () => {
		expect(
			usageReadout({
				journalBytes: 128 * MIB,
				ceiling,
				retention: { ...deviceLimit, maxSizeMb: 512 },
			}),
		).toEqual({ used: 128 * MIB, limit: 256 * MIB, percent: 50 });
	});

	it("caps the bar at full while the journal is still above the limit", () => {
		expect(
			usageReadout({
				journalBytes: 96 * MIB,
				ceiling,
				retention: { ...deviceLimit, maxSizeMb: 64 },
			}),
		).toEqual({ used: 96 * MIB, limit: 64 * MIB, percent: 100 });
	});

	it("shows an exactly full journal as full and an empty one as empty", () => {
		expect(
			usageReadout({ journalBytes: 256 * MIB, ceiling, retention: deviceLimit })
				.percent,
		).toBe(100);
		expect(
			usageReadout({ journalBytes: 0, ceiling, retention: deviceLimit }),
		).toEqual({ used: 0, limit: 256 * MIB, percent: 0 });
	});

	it("has no limit and no bar when the ceiling is unknown", () => {
		expect(
			usageReadout({
				journalBytes: 10 * MIB,
				ceiling: null,
				retention: { ...deviceLimit, maxSizeMb: 64 },
			}),
		).toEqual({ used: 10 * MIB, limit: null, percent: null });
	});

	it("keeps unreported usage unknown, never zero", () => {
		expect(
			usageReadout({ journalBytes: null, ceiling, retention: deviceLimit }),
		).toEqual({ used: null, limit: 256 * MIB, percent: null });
	});
});

describe("onDiskTotal", () => {
	it("returns the directory total only when it exceeds what journald counts", () => {
		expect(onDiskTotal({ journalBytes: 10, journalDirBytes: 11 })).toBe(11);
		expect(onDiskTotal({ journalBytes: 10, journalDirBytes: 10 })).toBeNull();
		expect(onDiskTotal({ journalBytes: 10, journalDirBytes: 9 })).toBeNull();
	});

	it("says nothing when either side is unknown", () => {
		expect(onDiskTotal({ journalBytes: null, journalDirBytes: 11 })).toBeNull();
		expect(onDiskTotal({ journalBytes: 10, journalDirBytes: null })).toBeNull();
		expect(
			onDiskTotal({ journalBytes: null, journalDirBytes: null }),
		).toBeNull();
	});
});

describe("volumeRows", () => {
	it("orders sources by size and gives each its share of the sampled bytes", () => {
		expect(
			volumeRows([
				{ source: "network", entries: 3, bytes: 100 },
				{ source: "app", entries: 9, bytes: 300 },
				{ source: null, entries: 1, bytes: 0 },
				{ source: "engine", entries: 2, bytes: 100 },
			]),
		).toEqual([
			{ source: "app", entries: 9, bytes: 300, share: 60 },
			{ source: "network", entries: 3, bytes: 100, share: 20 },
			{ source: "engine", entries: 2, bytes: 100, share: 20 },
			{ source: null, entries: 1, bytes: 0, share: 0 },
		]);
	});

	it("gives every row a zero share when the sample carried no bytes", () => {
		expect(
			volumeRows([
				{ source: "app", entries: 4, bytes: 0 },
				{ source: "kernel", entries: 1, bytes: 0 },
			]),
		).toEqual([
			{ source: "app", entries: 4, bytes: 0, share: 0 },
			{ source: "kernel", entries: 1, bytes: 0, share: 0 },
		]);
	});

	it("returns nothing for an empty sample and leaves its input untouched", () => {
		expect(volumeRows([])).toEqual([]);
		const input = [
			{ source: "app" as const, entries: 1, bytes: 1 },
			{ source: "kernel" as const, entries: 1, bytes: 2 },
		];
		volumeRows(input);
		expect(input.map((row) => row.source)).toEqual(["app", "kernel"]);
	});
});

describe("parseStorage", () => {
	it("reads a reply that matches this build's schema", () => {
		const storage = logStorage();
		expect(parseStorage(storage)).toEqual(storage);
	});

	it("drops fields a newer device adds, at any depth, and keeps every known one", () => {
		const storage = logStorage({
			lastMaintenance: { at: Date.UTC(2026, 10, 2), ok: true, targetMet: true },
		});
		const reply = {
			...storage,
			addedLater: 1,
			ceiling: { maxSizeMb: 256, maxAgeDays: 30, addedLater: 2 },
			retention: { ...storage.retention, addedLater: 3 },
			recentVolume: storage.recentVolume.map((row, index) =>
				index === 1 ? { ...row, addedLater: 4 } : row,
			),
			lastMaintenance: { ...storage.lastMaintenance, addedLater: 5 },
		};

		expect(parseStorage(reply)).toEqual(storage);
	});

	it("still rejects a reply whose known fields are missing or invalid", () => {
		const schemaError = expect.objectContaining({ name: "ZodError" });
		expect(() => parseStorage({})).toThrow(schemaError);
		expect(() => parseStorage(undefined)).toThrow(schemaError);
		expect(() =>
			parseStorage({
				...logStorage(),
				ceiling: { maxSizeMb: "big", maxAgeDays: 30 },
				addedLater: 1,
			}),
		).toThrow(schemaError);
	});
});

describe("keepWhole", () => {
	it("joins every space of a formatted size or date with a no-break space", () => {
		expect(keepWhole("5 MB")).toBe("5\u00a0MB");
		expect(keepWhole("7 nov 2026, 2:40")).toBe(
			"7\u00a0nov\u00a02026,\u00a02:40",
		);
		expect(keepWhole("2026. 11. 16. 오후 8:31")).toBe(
			"2026.\u00a011.\u00a016.\u00a0오후\u00a08:31",
		);
	});

	it("leaves a value without plain spaces, and an unknown value, as they are", () => {
		expect(keepWhole("4\u202f096")).toBe("4\u202f096");
		expect(keepWhole(undefined)).toBeUndefined();
	});
});

describe("betweenWords", () => {
	const hint = "保留调试条目，占用更多空间，最适合排查问题";

	it("lets Chinese wrap only between two words of two or more characters", () => {
		expect(betweenWords(hint, "zh")).toBe(
			"保留调试条目，占用\u200b更多\u200b空间，最适合排查问题",
		);
		expect(betweenWords("删除残留的调试文件", "zh-CN")).toBe(
			"删除\u200b残留的调试文件",
		);
	});

	it("keeps a number with its unit and adds nothing beside punctuation or spaces", () => {
		expect(betweenWords("2026年11月17日", "zh")).toBe("2026年11月17日");
		expect(betweenWords("日志2026条目", "zh")).toBe("日志2026条目");
		expect(betweenWords("日志……占用", "zh")).toBe("日志……占用");
		expect(betweenWords("日志  占用", "zh")).toBe("日志  占用");
		expect(betweenWords("日志占用 48\u00a0MB，限制 256\u00a0MB", "zh")).toBe(
			"日志\u200b占用 48\u00a0MB，限制 256\u00a0MB",
		);
	});

	it.each(["en", "ja", "ko", "es"])("leaves %s text as it is", (locale) => {
		expect(betweenWords(hint, locale)).toBe(hint);
	});
});
