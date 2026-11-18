import type { LogEntry, LogFollowMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	capRows,
	displayRows,
	entryRows,
	followRows,
	newestCursor,
	newRows,
	placeRows,
	type RawRow,
	ROW_CAP,
	withMoment,
} from "./raw-rows";

const BOOT_A = "66d8d1808694489b8c3a3fb4795cab24";
const BOOT_B = "0123456789abcdef0123456789abcdef";

function entry(cursor: string, patch: Partial<LogEntry> = {}): LogEntry {
	return {
		cursor,
		ts: 1_000,
		bootId: BOOT_A,
		level: "info",
		source: "app",
		unit: "ceralive.service",
		message: `message ${cursor}`,
		truncated: false,
		marker: null,
		...patch,
	};
}

function message(patch: Partial<LogFollowMessage> = {}): LogFollowMessage {
	return {
		subscriptionId: "sub",
		entries: [],
		checkpointCursor: null,
		dropped: 0,
		...patch,
	};
}

const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key);
const kinds = (rows: readonly { kind: string }[]) =>
	rows.map((row) => row.kind);

describe("raw-rows — entryRows and newestCursor", () => {
	it("keys each entry by its cursor", () => {
		const rows = entryRows([entry("s=1"), entry("s=2")]);
		expect(rows).toEqual([
			{ kind: "entry", key: "s=1", entry: entry("s=1") },
			{ kind: "entry", key: "s=2", entry: entry("s=2") },
		]);
	});

	it("reads the first entry's cursor, skipping markers, or null", () => {
		const marker: RawRow = {
			kind: "marker",
			key: "m",
			marker: "dropped",
			count: 2,
		};
		expect(newestCursor([marker, ...entryRows([entry("s=7")])])).toBe("s=7");
		expect(newestCursor([marker])).toBeNull();
		expect(newestCursor([])).toBeNull();
	});
});

describe("raw-rows — newRows", () => {
	it("drops entries whose cursor is already shown and keeps markers", () => {
		const shown = entryRows([entry("s=1"), entry("s=2")]);
		const marker: RawRow = {
			kind: "marker",
			key: "dropped-1",
			marker: "dropped",
			count: 1,
		};
		const incoming = [marker, ...entryRows([entry("s=3"), entry("s=2")])];
		expect(keys(newRows([...shown, marker], incoming))).toEqual([
			"dropped-1",
			"s=3",
		]);
	});

	it("drops a cursor repeated inside the incoming rows", () => {
		expect(keys(newRows([], entryRows([entry("s=1"), entry("s=1")])))).toEqual([
			"s=1",
		]);
	});
});

describe("raw-rows — placeRows", () => {
	const rows = (...cursors: string[]) =>
		entryRows(cursors.map((cursor) => entry(cursor)));
	const gap: RawRow = {
		kind: "marker",
		key: "dropped-1",
		marker: "dropped",
		count: 1,
	};

	it("orders the entries a head page shares with the rows shown as the page does", () => {
		expect(keys(placeRows(rows("a"), rows("b", "a", "old"), "head"))).toEqual([
			"b",
			"a",
			"old",
		]);
	});

	it("replaces the rows with a head page that fills a dropped hole, and the marker leaves", () => {
		const shown = [...rows("q"), gap, ...rows("o", "n")];
		expect(
			keys(placeRows(shown, rows("q", "p", "o", "n", "m"), "head")),
		).toEqual(["q", "p", "o", "n", "m"]);
		expect(keys(placeRows(shown, [], "head"))).toEqual([
			"q",
			"dropped-1",
			"o",
			"n",
		]);
	});

	it("extends only its own edge with the rows not listed yet", () => {
		expect(
			keys(placeRows([gap, ...rows("a")], rows("o2", "o1"), "below")),
		).toEqual(["dropped-1", "a", "o2", "o1"]);
		expect(keys(placeRows(rows("b", "a"), rows("a", "z"), "below"))).toEqual([
			"b",
			"a",
			"z",
		]);
		expect(keys(placeRows(rows("a"), rows("c", "b", "a"), "above"))).toEqual([
			"c",
			"b",
			"a",
		]);
		expect(keys(placeRows([], rows("o2", "o1"), "head"))).toEqual(["o2", "o1"]);
	});
});

describe("raw-rows — capRows", () => {
	it("keeps everything at or under the cap", () => {
		const rows = entryRows([entry("s=1"), entry("s=2")]);
		expect(capRows(rows, 2)).toEqual({ rows, removed: 0 });
		expect(capRows(rows, 3)).toEqual({ rows, removed: 0 });
	});

	it("keeps the rows nearest the top and counts the entries removed", () => {
		const marker: RawRow = {
			kind: "marker",
			key: "m",
			marker: "dropped",
			count: 4,
		};
		const rows = [
			...entryRows([entry("s=1")]),
			marker,
			...entryRows([entry("s=2"), entry("s=3"), entry("s=4")]),
		];
		const result = capRows(rows, 2);
		expect(keys(result.rows)).toEqual(["s=1", "m", "s=2"]);
		expect(result.removed).toBe(2);
	});

	it("caps at 2000 entries by default", () => {
		expect(ROW_CAP).toBe(2000);
		const rows = entryRows(
			Array.from({ length: 2001 }, (_, index) => entry(`s=${index}`)),
		);
		const result = capRows(rows);
		expect(result.rows).toHaveLength(2000);
		expect(result.rows.at(-1)?.key).toBe("s=1999");
		expect(result.removed).toBe(1);
	});

	it("drops a marker that would sit below the last kept entry", () => {
		const rows: RawRow[] = [
			...entryRows([entry("s=1")]),
			{ kind: "marker", key: "m", marker: "dropped", count: 1 },
		];
		expect(capRows(rows, 1)).toEqual({ rows: rows.slice(0, 2), removed: 0 });
		const more = [...rows, ...entryRows([entry("s=2")])];
		expect(keys(capRows(more, 1).rows)).toEqual(["s=1"]);
	});
});

describe("raw-rows — followRows", () => {
	it("shows a batch newest first", () => {
		const rows = followRows(
			message({ entries: [entry("s=1"), entry("s=2"), entry("s=3")] }),
			7,
		);
		expect(keys(rows)).toEqual(["s=3", "s=2", "s=1"]);
	});

	it.each([1, 3])(
		"puts %i entries dropped while following above the batch they followed",
		(dropped) => {
			const rows = followRows(message({ entries: [entry("s=1")], dropped }), 7);
			expect(rows[0]).toEqual({
				kind: "marker",
				key: "dropped-7",
				marker: "dropped",
				count: dropped,
			});
			expect(keys(rows)).toEqual(["dropped-7", "s=1"]);
		},
	);

	it.each([
		["catchup_exceeded", "catchupExceeded"],
		["cursor_unavailable", "cursorUnavailable"],
	] as const)(
		"marks a %s gap below the entries that came after it",
		(gap, marker) => {
			const rows = followRows(message({ entries: [entry("s=4")], gap }), 2);
			expect(keys(rows)).toEqual(["s=4", `gap-2`]);
			expect(rows[1]).toEqual({
				kind: "marker",
				key: "gap-2",
				marker,
				count: 0,
			});
		},
	);

	it("adds no row for a suppressed gap, whose notice is an entry of the batch", () => {
		const notice = entry("s=5", { marker: "suppressed" });
		const rows = followRows(
			message({ entries: [notice], gap: "suppressed" }),
			1,
		);
		expect(keys(rows)).toEqual(["s=5"]);
	});

	it("returns nothing for an empty batch", () => {
		expect(followRows(message(), 1)).toEqual([]);
	});
});

describe("raw-rows — displayRows", () => {
	const day = (ts: number) => String(Math.floor(ts / 100));

	it("opens the list with a date row and keeps the rows in order", () => {
		const rows = entryRows([
			entry("s=2", { ts: 120 }),
			entry("s=1", { ts: 110 }),
		]);
		const display = displayRows(rows, true, day);
		expect(display[0]).toEqual({ kind: "date", key: "date-s=2", ts: 120 });
		expect(keys(display)).toEqual(["date-s=2", "s=2", "s=1"]);
	});

	it("adds a date row wherever the day changes", () => {
		const rows = entryRows([
			entry("s=3", { ts: 210 }),
			entry("s=2", { ts: 120 }),
			entry("s=1", { ts: 110 }),
		]);
		expect(keys(displayRows(rows, true, day))).toEqual([
			"date-s=3",
			"s=3",
			"date-s=2",
			"s=2",
			"s=1",
		]);
	});

	it("marks a backwards clock between two entries of one boot, newest first", () => {
		const rows = entryRows([
			entry("s=2", { ts: 105 }),
			entry("s=1", { ts: 150 }),
		]);
		const display = displayRows(rows, true, day);
		expect(keys(display)).toEqual(["date-s=2", "s=2", "clock-s=1", "s=1"]);
		expect(display[2]).toEqual({ kind: "clock", key: "clock-s=1" });
	});

	it("marks a backwards clock oldest first", () => {
		const rows = entryRows([
			entry("s=1", { ts: 150 }),
			entry("s=2", { ts: 105 }),
		]);
		expect(kinds(displayRows(rows, false, day))).toEqual([
			"date",
			"entry",
			"clock",
			"entry",
		]);
	});

	it("never marks equal times, forward time or a boot change", () => {
		const equal = entryRows([
			entry("s=2", { ts: 150 }),
			entry("s=1", { ts: 150 }),
		]);
		const forwardNewest = entryRows([
			entry("s=2", { ts: 160 }),
			entry("s=1", { ts: 150 }),
		]);
		const forwardOldest = entryRows([
			entry("s=1", { ts: 150 }),
			entry("s=2", { ts: 160 }),
		]);
		const otherBoot = entryRows([
			entry("s=2", { ts: 105 }),
			entry("s=1", { ts: 150, bootId: BOOT_B }),
		]);
		expect(kinds(displayRows(equal, true, day))).not.toContain("clock");
		expect(kinds(displayRows(forwardNewest, true, day))).not.toContain("clock");
		expect(kinds(displayRows(forwardOldest, false, day))).not.toContain(
			"clock",
		);
		expect(kinds(displayRows(otherBoot, true, day))).not.toContain("clock");
	});

	it("compares entries across a marker and keeps the marker in place", () => {
		const rows: RawRow[] = [
			...entryRows([entry("s=3", { ts: 210 })]),
			{ kind: "marker", key: "gap-1", marker: "cursorUnavailable", count: 0 },
			...entryRows([entry("s=2", { ts: 120 })]),
		];
		expect(keys(displayRows(rows, true, day))).toEqual([
			"date-s=3",
			"s=3",
			"gap-1",
			"date-s=2",
			"s=2",
		]);
	});

	it("puts a leading marker before the first date row", () => {
		const rows: RawRow[] = [
			{ kind: "marker", key: "dropped-1", marker: "dropped", count: 1 },
			...entryRows([entry("s=1", { ts: 120 })]),
		];
		expect(keys(displayRows(rows, true, day))).toEqual([
			"dropped-1",
			"date-s=1",
			"s=1",
		]);
	});

	it("uses the local calendar day by default", () => {
		const late = new Date(2026, 10, 15, 23, 59, 59).getTime();
		const early = new Date(2026, 10, 16, 0, 0, 1).getTime();
		const sameDay = new Date(2026, 10, 15, 0, 0, 1).getTime();
		const rows = entryRows([
			entry("s=3", { ts: early }),
			entry("s=2", { ts: late }),
			entry("s=1", { ts: sameDay }),
		]);
		expect(kinds(displayRows(rows, true))).toEqual([
			"date",
			"entry",
			"date",
			"entry",
			"entry",
		]);
	});

	it("returns nothing for no rows", () => {
		expect(displayRows([], true, day)).toEqual([]);
	});
});

describe("raw-rows: withMoment", () => {
	const day = (ts: number) => String(Math.floor(ts / 100));
	const newestFirst = (...entries: LogEntry[]) =>
		displayRows(entryRows(entries), true, day);

	it("puts the selected moment between the newer entries and the first entry at or before it", () => {
		const display = newestFirst(
			entry("s=3", { ts: 130 }),
			entry("s=2", { ts: 120 }),
			entry("s=1", { ts: 110 }),
		);
		const marked = withMoment(display, 120);
		expect(keys(marked)).toEqual(["date-s=3", "s=3", "moment", "s=2", "s=1"]);
		expect(marked[2]).toEqual({ kind: "moment", key: "moment", ts: 120 });
	});

	it("puts it above the date row that opens the first older entry's day", () => {
		const display = newestFirst(
			entry("s=2", { ts: 210 }),
			entry("s=1", { ts: 120 }),
		);
		expect(keys(withMoment(display, 150))).toEqual([
			"date-s=2",
			"s=2",
			"moment",
			"date-s=1",
			"s=1",
		]);
	});

	it("puts it last when every entry is newer, and first when none is", () => {
		const display = newestFirst(
			entry("s=2", { ts: 120 }),
			entry("s=1", { ts: 110 }),
		);
		expect(keys(withMoment(display, 100))).toEqual([
			"date-s=2",
			"s=2",
			"s=1",
			"moment",
		]);
		expect(keys(withMoment(display, 130))).toEqual([
			"moment",
			"date-s=2",
			"s=2",
			"s=1",
		]);
	});
});
