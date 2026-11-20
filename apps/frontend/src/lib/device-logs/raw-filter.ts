/**
 * What the Raw logs controls mean on the wire. The view keeps operator choices
 * (a level position, a time preset, an order); these functions turn them into
 * the `logs.query` and `logs.followStart` inputs the device accepts.
 */
import type {
	LogFollowStartInput,
	LogLevel,
	LogQueryInput,
	LogSource,
} from "@ceraui/rpc/schemas";

export type RawLevel = "errors" | "warnings" | "info" | "everything";
export type RawTime = "current" | "15m" | "1h" | "24h" | "all";
export type RawOrder = "newest" | "oldest";

export interface RawFilter {
	/** Empty means every source. */
	readonly sources: readonly LogSource[];
	readonly level: RawLevel;
	readonly time: RawTime;
	/** A boot chosen in the boot picker; it overrides `time` while set. */
	readonly bootId: string | null;
	readonly text: string;
	readonly order: RawOrder;
}

export const DEFAULT_RAW_FILTER: RawFilter = {
	sources: [],
	level: "info",
	time: "current",
	bootId: null,
	text: "",
	order: "newest",
};

export const LEVEL_SETS: Readonly<Record<RawLevel, readonly LogLevel[]>> = {
	errors: ["error"],
	warnings: ["error", "warning"],
	info: ["error", "warning", "info"],
	everything: ["error", "warning", "info", "debug"],
};

/** The narrowest Level position that shows every level in `levels`. */
export function levelCovering(levels: readonly LogLevel[]): RawLevel {
	for (const level of ["errors", "warnings", "info"] as const)
		if (levels.every((one) => LEVEL_SETS[level].includes(one))) return level;
	return "everything";
}

const WINDOW_MS: Partial<Record<RawTime, number>> = {
	"15m": 15 * 60_000,
	"1h": 60 * 60_000,
	"24h": 24 * 60 * 60_000,
};

const PAGE_LIMIT = 100;
const SEARCH_MAX_BYTES = 256;
const encoder = new TextEncoder();

function shared(filter: RawFilter) {
	return {
		sources: [...filter.sources],
		levels: [...LEVEL_SETS[filter.level]],
		...(filter.text === "" ? {} : { text: filter.text }),
	};
}

/** `now` resolves a time window once; later pages reuse the returned input. */
export function queryInput(filter: RawFilter, now: number): LogQueryInput {
	const span = filter.bootId === null ? WINDOW_MS[filter.time] : undefined;
	return {
		...shared(filter),
		boot: filter.bootId ?? (filter.time === "current" ? "current" : "all"),
		...(span === undefined ? {} : { since: Math.max(0, now - span) }),
		direction: filter.order === "newest" ? "older" : "newer",
		limit: PAGE_LIMIT,
	};
}

export function followInput(
	filter: RawFilter,
	afterCursor: string | null,
): LogFollowStartInput {
	return {
		...shared(filter),
		...(afterCursor === null ? {} : { afterCursor }),
	};
}

/** Why Follow is unavailable: it reads only this boot, newest first. */
export function followBlock(
	filter: RawFilter,
	anchored: boolean,
): "anchor" | "filter" | null {
	if (anchored) return "anchor";
	const thisBoot = filter.bootId === null && filter.time === "current";
	return thisBoot && filter.order === "newest" ? null : "filter";
}

/** What Time shows: a chosen boot, or the one boot an anchor window reads. */
export function timeShown(
	filter: RawFilter,
	anchored: boolean,
): RawTime | "boot" {
	return anchored || filter.bootId !== null ? "boot" : filter.time;
}

/** Source, Time and Order fold behind the Filters button on small screens. */
export function foldedFilterCount(
	filter: RawFilter,
	anchored: boolean,
): number {
	return [
		filter.sources.length > 0,
		timeShown(filter, anchored) !== "current",
		filter.order !== "newest",
	].filter(Boolean).length;
}

/** The device accepts at most 256 UTF-8 bytes of search text and no NUL. */
export function searchText(raw: string): string {
	let text = "";
	let bytes = 0;
	for (const char of raw.replaceAll("\0", "")) {
		bytes += encoder.encode(char).length;
		if (bytes > SEARCH_MAX_BYTES) break;
		text += char;
	}
	return text;
}
