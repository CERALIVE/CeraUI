import type { LogFollowMessage } from "@ceraui/rpc/schemas";
import {
	capRows,
	followRows,
	marker,
	newestCursor,
	newRows,
	type Placement,
	placeRows,
	type RawRow,
} from "./raw-rows";

const HELD_CAP = 500;

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

	clear(): void {
		this.#list = [];
		this.#shownFrom = null;
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
		this.place(added, "above");
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
	#write(next: RawRow[]): void {
		const from =
			this.#shownFrom ?? (this.#atTop ? null : (this.#list[0]?.key ?? null));
		const at = from === null ? 0 : this.#boundaryIn(next, from);
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
		const shown = capRows(next.slice(at));
		if (shown.removed > 0) this.capped = true;
		this.#list = [...held.rows, ...notices, ...shown.rows];
		this.#shownFrom =
			held.rows.length + notices.length === 0
				? null
				: (shown.rows[0]?.key ?? null);
	}

	/** Where the first shown row sits in `next`, or the next shown row it kept. */
	#boundaryIn(next: readonly RawRow[], from: string): number {
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
