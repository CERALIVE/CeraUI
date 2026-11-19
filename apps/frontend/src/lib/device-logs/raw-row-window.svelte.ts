import type { LogFollowMessage, LogQueryOutput } from "@ceraui/rpc/schemas";
import {
	capRows,
	entryRows,
	followRows,
	marker,
	newestCursor,
	newRows,
	type Placement,
	placeRows,
	type RawRow,
	ROW_CAP,
} from "./raw-rows";

const HELD_CAP = 500;
const GAP_CAP = 32;

/** One journal-ordered list with a boundary between held and shown rows. */
export class RawRowWindow {
	#list = $state.raw<RawRow[]>([]);
	#shownFrom = $state<string | null>(null);
	readonly #boundary = $derived(
		this.#shownFrom === null
			? 0
			: this.#list.findIndex((row) => row.key === this.#shownFrom),
	);
	rows = $derived(this.#list.slice(this.#boundary));
	held = $derived(this.#list.slice(0, this.#boundary));
	capped = $state(false);
	gapLimitReached = $state(false);
	#atTop = true;
	#heldDropped = 0;
	#serial = 0;

	get newest(): string | null {
		return newestCursor(this.#list);
	}

	get newestBoot(): string | undefined {
		return this.#list.find((row) => row.kind === "entry")?.entry.bootId;
	}

	has(cursor: string): boolean {
		return this.#list.some((row) => row.key === cursor);
	}

	fillGap(key: string, result: LogQueryOutput): string | null | undefined {
		const index = this.#list.findIndex((row) => row.key === key);
		const gap = this.#list[index];
		if (gap?.kind !== "marker") return;
		const { gapFrom, gapError: _previousError, ...markerRow } = gap;
		const incoming = result.ok
			? newRows([], entryRows([...result.entries].reverse()))
			: [];
		const recovered = new Set(incoming.map((row) => row.key));
		const markerRows = !result.ok
			? [
					{
						...markerRow,
						...(result.error === "CURSOR_UNAVAILABLE" ||
						result.error === "FILTER_CHANGED"
							? {}
							: { gapFrom }),
						gapError: result.error,
					},
				]
			: result.continuation === null
				? []
				: [{ ...markerRow, gapFrom: result.continuation }];
		const boundary = this.#boundary;
		const held = this.#list
			.slice(0, boundary)
			.filter((row) => !recovered.has(row.key));
		const before = this.#list
			.slice(boundary, index)
			.filter((row) => !recovered.has(row.key));
		const after = this.#list
			.slice(index + 1)
			.filter((row) => !recovered.has(row.key));
		// Keep the entire requested page by taking space from the newest edge.
		let room = Math.max(
			0,
			ROW_CAP -
				incoming.length -
				after.filter((row) => row.kind === "entry").length,
		);
		const nearer = before.findLastIndex(
			(row) => row.kind === "entry" && --room < 0,
		);
		const above =
			nearer === -1
				? before
				: before.filter((row, at) => at > nearer || hasGapPosition(row));
		if (nearer !== -1) {
			this.capped = true;
			this.#atTop = false;
		}
		const next = [...held, ...above, ...markerRows, ...incoming, ...after];
		this.#write(next, held.length);
		if (markerRows.some(hasGapPosition)) return key;
		return (
			[...incoming, ...after, ...above.reverse()].find(
				(row) =>
					row.kind === "entry" &&
					row.entry.marker === null &&
					this.has(row.key),
			)?.key ?? null
		);
	}

	clear(): void {
		this.#list = [];
		this.#shownFrom = null;
		this.gapLimitReached = false;
		this.reopen();
	}

	/** A head page can restore entries that the caps cut. */
	reopen(): void {
		this.#heldDropped = 0;
		this.capped = false;
	}

	place(rows: readonly RawRow[], placement: Placement): void {
		this.#write(placeRows(this.#list, rows, placement));
	}

	showAnchor(rows: readonly RawRow[]): void {
		this.#write(placeRows([], rows, "below"));
	}

	appendBatch(message: LogFollowMessage): number {
		const added = newRows(this.#list, followRows(message, ++this.#serial));
		const atGapLimit =
			message.gapFrom !== undefined &&
			this.#list.filter(hasGapPosition).length === GAP_CAP;
		if (atGapLimit) this.gapLimitReached = true;
		this.place(
			atGapLimit ? added.filter((row) => !hasGapPosition(row)) : added,
			"above",
		);
		if (
			message.gapFrom !== undefined &&
			!atGapLimit &&
			this.held.every((row) => row.kind === "marker")
		)
			this.#shownFrom = null;
		return added.filter((row) => row.kind === "entry").length;
	}

	setAtTop(atTop: boolean): void {
		this.#atTop = atTop;
	}

	showHeld(): void {
		const skipped =
			this.#heldDropped > 0
				? [
						marker(
							"dropped",
							`dropped-held-${++this.#serial}`,
							this.#heldDropped,
						),
					]
				: [];
		const next = [...this.held, ...skipped, ...this.rows];
		this.#shownFrom = null;
		this.#heldDropped = 0;
		this.#atTop = true;
		this.#write(next);
	}

	/** Rows above the first shown row wait while the operator reads away from the top. */
	#write(next: RawRow[], at = this.#boundaryIn(next)): void {
		const held = capRows(next.slice(0, at), HELD_CAP);
		// Cut skip counts join the overflow count. Gap notices stay at the boundary.
		const cut = next.slice(held.rows.length, at);
		const notices = cut.filter(
			(row) => row.kind === "marker" && row.marker !== "dropped",
		);
		this.#heldDropped += cut.reduce(
			(count, row) =>
				count +
				(row.kind === "entry" ? 1 : row.marker === "dropped" ? row.count : 0),
			0,
		);
		const display = next.slice(at);
		const shown = capRows(display);
		if (shown.removed > 0) this.capped = true;
		// Entry eviction must never consume the only continuation for a gap.
		const skippedGaps = display.slice(shown.rows.length).filter(hasGapPosition);
		this.#list = [...held.rows, ...notices, ...shown.rows, ...skippedGaps];
		this.#shownFrom =
			held.rows.length + notices.length === 0
				? null
				: (shown.rows[0]?.key ?? null);
	}

	/** Where the first shown row sits in `next`, or the next shown row it kept. */
	#boundaryIn(next: readonly RawRow[]): number {
		const from =
			this.#shownFrom ?? (this.#atTop ? null : (this.#list[0]?.key ?? null));
		if (from === null) return 0;
		const keys = next.map((row) => row.key);
		const shown = this.#list.slice(
			this.#list.findIndex((row) => row.key === from),
		);
		for (const row of shown) {
			const index = keys.indexOf(row.key);
			if (index >= 0) return index;
		}
		return 0;
	}
}

function hasGapPosition(row: RawRow): boolean {
	return row.kind === "marker" && row.gapFrom !== undefined;
}
