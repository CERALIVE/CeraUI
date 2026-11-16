/**
 * The Raw logs list as rows: entries keyed by journal cursor plus marker rows
 * that state what was skipped. The list is ordered top to bottom as shown, and
 * its shown part never holds more than ROW_CAP entries: the rows nearest the
 * top are kept.
 */
import type { LogEntry, LogFollowMessage } from "@ceraui/rpc/schemas";

export const ROW_CAP = 2000;

export type MarkerKind = "dropped" | "catchupExceeded" | "cursorUnavailable";

export type RawRow =
	| { readonly kind: "entry"; readonly key: string; readonly entry: LogEntry }
	| {
			readonly kind: "marker";
			readonly key: string;
			readonly marker: MarkerKind;
			readonly count: number;
	  };

export type DisplayRow =
	| RawRow
	| { readonly kind: "date"; readonly key: string; readonly ts: number }
	| { readonly kind: "clock"; readonly key: string };

const GAP_MARKERS: Partial<
	Record<NonNullable<LogFollowMessage["gap"]>, MarkerKind>
> = {
	catchup_exceeded: "catchupExceeded",
	cursor_unavailable: "cursorUnavailable",
};

export function entryRows(entries: readonly LogEntry[]): RawRow[] {
	return entries.map((entry) => ({ kind: "entry", key: entry.cursor, entry }));
}

export function newestCursor(rows: readonly RawRow[]): string | null {
	const first = rows.find((row) => row.kind === "entry");
	return first?.kind === "entry" ? first.entry.cursor : null;
}

/** Incoming rows minus every entry already shown (or repeated among them). */
export function newRows(
	shown: readonly RawRow[],
	incoming: readonly RawRow[],
): RawRow[] {
	const seen = new Set(shown.map((row) => row.key));
	return incoming.filter((row) => {
		if (row.kind !== "entry") return true;
		if (seen.has(row.key)) return false;
		seen.add(row.key);
		return true;
	});
}

/** Where a source's rows go: above or below the list, or in place of it. */
export type Placement = "above" | "below" | "head";

/**
 * One source's rows placed by the journal run it delivers. The first page with
 * entries after a head read replaces the list: it is the newest complete run
 * (scan-page.ts) and nothing could arrive meanwhile, so every listed row is in
 * it or older than its last entry, where the bottom edge pages from. Any other
 * page or Follow batch extends its own edge with the rows not listed yet.
 */
export function placeRows(
	list: readonly RawRow[],
	incoming: readonly RawRow[],
	placement: Placement,
): RawRow[] {
	if (placement === "head")
		return incoming.length === 0 ? [...list] : newRows([], incoming);
	const added = newRows(list, incoming);
	return placement === "above" ? [...added, ...list] : [...list, ...added];
}

/** Ends the rows at the `cap`-th entry and counts the entries cut. */
export function capRows(
	rows: readonly RawRow[],
	cap = ROW_CAP,
): { rows: RawRow[]; removed: number } {
	const entries = rows.filter((row) => row.kind === "entry").length;
	if (entries <= cap) return { rows: [...rows], removed: 0 };
	let kept = 0;
	const last = rows.findIndex((row) => row.kind === "entry" && ++kept === cap);
	return { rows: rows.slice(0, last + 1), removed: entries - cap };
}

/**
 * One follow message as rows, newest first: entries dropped after the batch
 * filled sit above it, and a gap the device reported sits below it. A
 * suppressed gap needs no row, because its journal notice is a batch entry.
 */
export function followRows(
	message: LogFollowMessage,
	serial: number,
): RawRow[] {
	const gap = message.gap === undefined ? undefined : GAP_MARKERS[message.gap];
	return [
		...(message.dropped > 0
			? [marker("dropped", `dropped-${serial}`, message.dropped)]
			: []),
		...entryRows([...message.entries].reverse()),
		...(gap === undefined ? [] : [marker(gap, `gap-${serial}`, 0)]),
	];
}

export function marker(kind: MarkerKind, key: string, count: number): RawRow {
	return { kind: "marker", key, marker: kind, count };
}

const localDay = (ts: number) => new Date(ts).toDateString();

/**
 * Adds a date row above the first entry and wherever the local day changes,
 * and a clock row where an entry was recorded earlier than the entry before
 * it in the same boot's journal order: the device clock moved back there.
 */
export function displayRows(
	rows: readonly RawRow[],
	newestFirst: boolean,
	dayOf: (ts: number) => string = localDay,
): DisplayRow[] {
	const display: DisplayRow[] = [];
	let previous: LogEntry | undefined;
	for (const row of rows) {
		if (row.kind === "entry") {
			const entry = row.entry;
			if (previous?.bootId === entry.bootId) {
				const [earlier, later] = newestFirst
					? [entry, previous]
					: [previous, entry];
				if (later.ts < earlier.ts)
					display.push({ kind: "clock", key: `clock-${entry.cursor}` });
			}
			if (previous === undefined || dayOf(previous.ts) !== dayOf(entry.ts))
				display.push({
					kind: "date",
					key: `date-${entry.cursor}`,
					ts: entry.ts,
				});
			previous = entry;
		}
		display.push(row);
	}
	return display;
}
