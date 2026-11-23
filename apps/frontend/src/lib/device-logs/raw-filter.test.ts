import { describe, expect, it } from "vitest";

import {
	DEFAULT_RAW_FILTER,
	foldedFilterCount,
	followBlock,
	followInput,
	isDefaultFilter,
	LEVEL_SETS,
	levelCovering,
	queryInput,
	type RawFilter,
	searchText,
	timeShown,
} from "./raw-filter";

const NOW = 1_800_000_000_000;
const BOOT = "66d8d1808694489b8c3a3fb4795cab24";

function filter(patch: Partial<RawFilter> = {}): RawFilter {
	return { ...DEFAULT_RAW_FILTER, ...patch };
}

describe("raw-filter: defaults and level sets", () => {
	it("starts on This boot, Info, newest first, all sources and no text", () => {
		expect(DEFAULT_RAW_FILTER).toEqual({
			sources: [],
			level: "info",
			time: "current",
			bootId: null,
			text: "",
			order: "newest",
		});
	});

	it("recognises a re-applied default by value and any changed field as a change", () => {
		expect(isDefaultFilter(filter())).toBe(true);
		for (const patch of [
			{ sources: ["app"] },
			{ level: "errors" },
			{ time: "1h" },
			{ bootId: BOOT },
			{ text: "x" },
			{ order: "oldest" },
		] satisfies Partial<RawFilter>[])
			expect(isDefaultFilter(filter(patch)), JSON.stringify(patch)).toBe(false);
	});

	it("maps each level position to the set it shows", () => {
		expect(LEVEL_SETS).toEqual({
			errors: ["error"],
			warnings: ["error", "warning"],
			info: ["error", "warning", "info"],
			everything: ["error", "warning", "info", "debug"],
		});
	});
});

describe("raw-filter: queryInput", () => {
	it("builds the first-page input of the default view", () => {
		expect(queryInput(DEFAULT_RAW_FILTER, NOW)).toStrictEqual({
			sources: [],
			levels: ["error", "warning", "info"],
			boot: "current",
			direction: "older",
			limit: 100,
		});
	});

	it("copies the sources and levels so the request never aliases view state", () => {
		const view = filter({ sources: ["engine", "kernel"] });
		const input = queryInput(view, NOW);
		expect(input.sources).toEqual(["engine", "kernel"]);
		expect(input.sources).not.toBe(view.sources);
		expect(input.levels).not.toBe(LEVEL_SETS.info);
	});

	it("passes the search text only when there is some", () => {
		expect(queryInput(filter({ text: "srt" }), NOW).text).toBe("srt");
		expect("text" in queryInput(filter({ text: "" }), NOW)).toBe(false);
	});

	it.each([
		["15m", 15 * 60_000],
		["1h", 60 * 60_000],
		["24h", 24 * 60 * 60_000],
	] as const)("resolves %s once as a since over every boot", (time, span) => {
		expect(queryInput(filter({ time }), NOW)).toStrictEqual({
			sources: [],
			levels: ["error", "warning", "info"],
			boot: "all",
			since: NOW - span,
			direction: "older",
			limit: 100,
		});
	});

	it("never sends a negative since when the clock is near the epoch", () => {
		expect(queryInput(filter({ time: "24h" }), 1000).since).toBe(0);
	});

	it("reads every stored boot with no since for All stored", () => {
		expect(queryInput(filter({ time: "all" }), NOW)).toStrictEqual({
			sources: [],
			levels: ["error", "warning", "info"],
			boot: "all",
			direction: "older",
			limit: 100,
		});
	});

	it("lets a boot chosen in the picker override the time preset", () => {
		const input = queryInput(filter({ time: "1h", bootId: BOOT }), NOW);
		expect(input.boot).toBe(BOOT);
		expect("since" in input).toBe(false);
	});

	it("reads oldest first as direction newer", () => {
		expect(queryInput(filter({ order: "oldest" }), NOW).direction).toBe(
			"newer",
		);
	});
});

describe("raw-filter: follow", () => {
	it("is available only on This boot, newest first, outside anchor mode", () => {
		expect(followBlock(DEFAULT_RAW_FILTER, false)).toBeNull();
		expect(followBlock(DEFAULT_RAW_FILTER, true)).toBe("anchor");
		expect(followBlock(filter({ order: "oldest" }), false)).toBe("filter");
		expect(followBlock(filter({ time: "15m" }), false)).toBe("filter");
		expect(followBlock(filter({ time: "all" }), false)).toBe("filter");
		expect(followBlock(filter({ bootId: BOOT }), false)).toBe("filter");
	});

	it("names anchor mode first even when the filter would also block", () => {
		expect(followBlock(filter({ order: "oldest" }), true)).toBe("anchor");
	});

	it("follows with the view's sources, levels and text after a cursor", () => {
		const view = filter({ sources: ["app"], level: "errors", text: "srt" });
		expect(followInput(view, "s=9")).toStrictEqual({
			sources: ["app"],
			levels: ["error"],
			text: "srt",
			afterCursor: "s=9",
		});
		expect(followInput(view, "s=9").sources).not.toBe(view.sources);
		expect(followInput(view, "s=9").levels).not.toBe(LEVEL_SETS.errors);
	});

	it("omits the cursor and an empty text", () => {
		expect(followInput(DEFAULT_RAW_FILTER, null)).toStrictEqual({
			sources: [],
			levels: ["error", "warning", "info"],
		});
	});
});

describe("raw-filter: folded filter count", () => {
	it("counts Source, Time and Order when they differ from the defaults", () => {
		expect(foldedFilterCount(DEFAULT_RAW_FILTER, false)).toBe(0);
		expect(foldedFilterCount(filter({ sources: ["engine"] }), false)).toBe(1);
		expect(foldedFilterCount(filter({ time: "1h" }), false)).toBe(1);
		expect(foldedFilterCount(filter({ bootId: BOOT }), false)).toBe(1);
		expect(foldedFilterCount(filter({ order: "oldest" }), false)).toBe(1);
		expect(
			foldedFilterCount(
				filter({ sources: ["app"], time: "all", order: "oldest" }),
				false,
			),
		).toBe(3);
	});

	it("does not count the level or the search text, which stay visible", () => {
		expect(
			foldedFilterCount(filter({ level: "errors", text: "x" }), false),
		).toBe(0);
	});

	it("counts an anchor window's boot under Time once", () => {
		expect(foldedFilterCount(DEFAULT_RAW_FILTER, true)).toBe(1);
		expect(foldedFilterCount(filter({ time: "1h" }), true)).toBe(1);
	});
});

describe("raw-filter: what the controls show for an anchor window", () => {
	it.each([
		[["error"], "errors"],
		[["error", "warning"], "warnings"],
		[["error", "warning", "info"], "info"],
		[["info"], "info"],
		[["debug"], "everything"],
		[["error", "warning", "info", "debug"], "everything"],
	] as const)("levels %j read as the %s position", (levels, level) => {
		expect(levelCovering(levels)).toBe(level);
	});

	it("shows the chosen time, or the one boot an anchor window reads", () => {
		expect(timeShown(DEFAULT_RAW_FILTER, false)).toBe("current");
		expect(timeShown(filter({ time: "1h" }), false)).toBe("1h");
		expect(timeShown(filter({ bootId: BOOT }), false)).toBe("boot");
		expect(timeShown(DEFAULT_RAW_FILTER, true)).toBe("boot");
		expect(timeShown(filter({ time: "all" }), true)).toBe("boot");
	});
});

describe("raw-filter: searchText", () => {
	it("keeps ordinary text exactly, spaces included", () => {
		expect(searchText(" srt link ")).toBe(" srt link ");
	});

	it("drops NUL characters the device refuses", () => {
		expect(searchText("a\0b\0")).toBe("ab");
	});

	it("keeps at most 256 UTF-8 bytes without splitting a character", () => {
		expect(searchText("a".repeat(256))).toBe("a".repeat(256));
		expect(searchText("a".repeat(257))).toBe("a".repeat(256));
		// 85 three-byte characters are 255 bytes; one more would be 258.
		expect(searchText("€".repeat(90))).toBe("€".repeat(85));
		expect(searchText(`${"a".repeat(255)}€`)).toBe("a".repeat(255));
		// A four-byte emoji counts as one character, never half of one.
		expect(searchText(`${"a".repeat(252)}😀`)).toBe(`${"a".repeat(252)}😀`);
		expect(searchText(`${"a".repeat(253)}😀`)).toBe("a".repeat(253));
	});
});
