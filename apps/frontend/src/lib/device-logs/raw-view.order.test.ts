/**
 * Event-order properties of RawView against a fake device that replies only
 * what the backend can. Pages follow scan-page.ts and page-window.ts: a first
 * page is the newest run at its read; budgets count examined records, so a
 * page can be empty yet positioned when the text search rejects what it read.
 * Follow follows follow.ts, follow-delivery.ts and follow-batch.ts: a start
 * without a cursor begins after the boot's newest record of any level, batches
 * keep matching records within 200 entries and 256 KiB per record test (so a
 * small record can be kept after a large one was dropped), and a stop discards
 * the unsent batch. Every order is replayed on a fresh view, the list
 * invariants are checked after each event, and the end check pages to the end
 * and compares the list with the journal.
 */
import type {
	LogEntry,
	LogFollowMessage,
	LogFollowStartInput,
	LogFollowStartOutput,
	LogFollowStopOutput,
	LogLevel,
	LogQueryInput,
	LogQueryOutput,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { displayRows, type RawRow } from "./raw-rows";
import { type AroundPage, RawView } from "./raw-view.svelte";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const T0 = 1_800_000_000_000;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BATCH_BYTES = 256 * 1024;
/** A 16 KiB message, the most parse.ts keeps, plus the entry's other fields. */
const LARGE = 16 * 1024 + 300;
const SMALL = 300;
const MATCH = "match";

/** A page stops at the end of the journal, or after examining k records. */
type Cut = "end" | number;

interface Reply<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function reply<T>(): Reply<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

interface Query {
	readonly input: LogQueryInput;
	readonly answer: Reply<LogQueryOutput>;
	readonly era: number;
	snapshot: number | null;
}

/** One sent Follow message: the run it covers and what it skipped. */
interface Sent {
	/** Journal indices from just after the previous checkpoint to this one. */
	readonly from: number;
	readonly to: number;
	readonly kept: readonly string[];
	readonly dropped: number;
}

interface Follower {
	readonly id: string;
	readonly filter: LogFollowStartInput;
	/** Journal index of the position the follower started after. */
	readonly start: number;
	/** Last record examined; records after it are pending. */
	examined: number;
	/** Last checkpoint sent; a stop returns it. */
	published: number;
	/** The start reply reached the view; a bootstrap stops its follower before then. */
	replied: boolean;
	/** Clear logs stopped it before its start reply, so that reply fails (follow.ts). */
	aborted: boolean;
	batch: { entries: LogEntry[]; bytes: number; dropped: number };
}

class Device {
	readonly journal: LogEntry[] = [];
	readonly sizes = new Map<string, number>();
	/** Records below this index were removed by Clear logs. */
	floor = 0;
	readonly queries: Query[] = [];
	readonly starts: (() => void)[] = [];
	readonly stops: (() => void)[] = [];
	readonly late: LogFollowMessage[] = [];
	readonly sent = new Map<string, Sent>();
	follower: Follower | null = null;
	listener: ((message: LogFollowMessage) => void) | undefined;
	/** Journal length at the newest completed head read, for I9. */
	headRead: number | null = null;
	era = 0;
	manualStart = false;
	manualStop = false;
	/** A stop sends the pending batch first, and the message arrives late. */
	lateFlush = false;
	connected = true;
	#ids = 0;
	#written = 0;

	write(
		cursor: string,
		patch: { level?: LogLevel; text?: string; size?: number; ts?: number } = {},
	): void {
		this.#at.set(cursor, this.journal.length);
		this.journal.push({
			cursor,
			ts: patch.ts ?? T0 + this.journal.length * 1000,
			bootId: BOOT,
			level: patch.level ?? "info",
			source: "app",
			unit: "ceralive.service",
			message: `${patch.text ?? MATCH} ${cursor}`,
			truncated: false,
			marker: null,
		});
		this.sizes.set(cursor, patch.size ?? SMALL);
	}

	readonly #at = new Map<string, number>();

	writeNext(patch: Parameters<Device["write"]>[1] = {}): void {
		const index = this.#written++;
		this.write(LETTERS[index] ?? `w${index}`, patch);
	}

	index(cursor: string): number {
		return this.#at.get(cursor) ?? -1;
	}

	/** What the journal call itself passes: levels; text and windows are residual. */
	static passes(
		entry: LogEntry,
		filter: { readonly levels?: readonly LogLevel[] },
	): boolean {
		return (filter.levels ?? ["error", "warning", "info"]).includes(
			entry.level,
		);
	}

	static matches(
		entry: LogEntry,
		filter: {
			readonly levels?: readonly LogLevel[];
			readonly text?: string;
			readonly since?: number;
			readonly until?: number;
		},
	): boolean {
		return (
			Device.passes(entry, filter) &&
			entry.message.includes(filter.text ?? "") &&
			entry.ts >= (filter.since ?? 0) &&
			entry.ts <= (filter.until ?? Number.MAX_SAFE_INTEGER)
		);
	}

	readonly logs = {
		query: (input: LogQueryInput): Promise<LogQueryOutput> => {
			const answer = reply<LogQueryOutput>();
			if (this.connected)
				this.queries.push({ input, answer, era: this.era, snapshot: null });
			else answer.resolve({ ok: false, error: "READ_FAILED" });
			return answer.promise;
		},
		followStart: (
			input: LogFollowStartInput,
		): Promise<LogFollowStartOutput> => {
			const answer = reply<LogFollowStartOutput>();
			if (!this.connected) {
				answer.resolve({ ok: false, error: "READ_FAILED" });
				return answer.promise;
			}
			this.#stop();
			const id = `sub-${++this.#ids}`;
			// follow-position.ts: the boot's newest record of any level, or the given cursor.
			let start = this.journal.length - 1;
			if (input.afterCursor !== undefined) {
				const at = this.index(input.afterCursor);
				if (at >= this.floor) start = at;
				else
					this.listener?.({
						subscriptionId: id,
						entries: [],
						checkpointCursor: null,
						dropped: 0,
						gap: "cursor_unavailable",
					});
			}
			if (start < this.floor) start = this.floor - 1;
			this.follower = {
				id,
				filter: input,
				start,
				examined: start,
				published: start,
				batch: { entries: [], bytes: 0, dropped: 0 },
				replied: !this.manualStart,
				aborted: false,
			};
			const follower = this.follower;
			const out: LogFollowStartOutput = {
				ok: true,
				subscriptionId: id,
				checkpointCursor: this.cursorAt(start),
			};
			if (this.manualStart)
				this.starts.push(() => {
					follower.replied = true;
					answer.resolve(
						follower.aborted ? { ok: false, error: "READ_FAILED" } : out,
					);
				});
			else answer.resolve(out);
			return answer.promise;
		},
		followStop: (): Promise<LogFollowStopOutput> => {
			const answer = reply<LogFollowStopOutput>();
			const had = this.follower !== null;
			const checkpoint = this.#stop();
			const out = had
				? { success: true, checkpointCursor: checkpoint }
				: { success: false, checkpointCursor: null };
			// A batch sent before the stop reaches the socket before the stop's reply.
			const settled = () => {
				this.deliverLate();
				answer.resolve(out);
			};
			if (this.manualStop) this.stops.push(settled);
			else queueMicrotask(settled);
			return answer.promise;
		},
	};

	/** follow-position.ts: a cursor only for a record the boot still has; Clear logs leaves none. */
	cursorAt(index: number): string | null {
		return index >= this.floor ? (this.journal[index]?.cursor ?? null) : null;
	}

	#stop(): string | null {
		const follower = this.follower;
		if (follower === null) return null;
		this.follower = null;
		if (this.lateFlush && follower.batch.entries.length > 0) {
			const message = this.#send(follower);
			this.late.push(message);
		}
		return this.cursorAt(follower.published);
	}

	#send(follower: Follower): LogFollowMessage {
		const { batch } = follower;
		const message: LogFollowMessage = {
			subscriptionId: follower.id,
			entries: batch.entries,
			checkpointCursor: this.cursorAt(follower.examined),
			dropped: batch.dropped,
		};
		const run: Sent = {
			from: follower.published + 1,
			to: follower.examined,
			kept: batch.entries.map((entry) => entry.cursor),
			dropped: batch.dropped,
		};
		for (const cursor of run.kept) this.sent.set(cursor, run);
		follower.published = follower.examined;
		follower.batch = { entries: [], bytes: 0, dropped: 0 };
		return message;
	}

	deliverLate(): void {
		for (const message of this.late.splice(0)) this.listener?.(message);
	}

	/** The flush timer fires: examine pending records (all, or up to the first kept one) and send. */
	flush(firstOnly = false): void {
		const follower = this.follower;
		if (follower === null) return;
		for (let i = follower.examined + 1; i < this.journal.length; i += 1) {
			const entry = this.journal[i] as LogEntry;
			if (i < this.floor || !Device.passes(entry, follower.filter)) continue;
			follower.examined = i;
			if (!Device.matches(entry, follower.filter)) continue;
			const size = this.sizes.get(entry.cursor) ?? SMALL;
			const { batch } = follower;
			if (batch.entries.length >= 200 || batch.bytes + size > BATCH_BYTES)
				batch.dropped += 1;
			else {
				batch.entries.push(entry);
				batch.bytes += size;
			}
			if (firstOnly && batch.entries.length > 0) break;
		}
		if (follower.batch.entries.length > 0)
			this.listener?.(this.#send(follower));
	}

	end(reason: "follower_exit" | "cleared"): void {
		const follower = this.follower;
		if (follower === null) return;
		if (reason === "follower_exit") this.flush();
		this.follower = null;
		follower.aborted = reason === "cleared";
		if (reason === "cleared") this.floor = this.journal.length;
		this.listener?.({
			subscriptionId: follower.id,
			entries: [],
			checkpointCursor: this.journal[follower.published]?.cursor ?? null,
			dropped: 0,
			ended: reason,
		});
	}

	disconnect(): void {
		this.connected = false;
		this.follower = null;
		for (const query of this.queries.splice(0))
			query.answer.resolve({ ok: false, error: "READ_FAILED" });
	}

	snapshot(): boolean {
		const query = this.queries.find((pending) => pending.snapshot === null);
		if (query === undefined) return false;
		query.snapshot = this.journal.length;
		return true;
	}

	/** Answers the oldest query with a page the backend could send. */
	answer(cut: Cut): Query | undefined {
		const query = this.queries.shift();
		if (query === undefined) return undefined;
		if (query.snapshot === null) query.snapshot = this.journal.length;
		const page = this.#page(query, cut);
		if (page.ok && query.input.continuation === undefined)
			this.headRead = Math.max(this.headRead ?? 0, query.snapshot);
		query.answer.resolve(page);
		return query;
	}

	#page(query: Query, cut: Cut): LogQueryOutput {
		const { input } = query;
		const end = query.snapshot ?? this.journal.length;
		const newer = input.direction === "newer";
		let run: LogEntry[];
		if (input.continuation === undefined)
			run = this.journal.slice(this.floor, end);
		else {
			const at = this.index(input.continuation.slice(4));
			if (at < this.floor) return { ok: false, error: "CURSOR_UNAVAILABLE" };
			run = newer
				? this.journal.slice(at + 1, end)
				: this.journal.slice(this.floor, at);
		}
		const examined = (newer ? run : [...run].reverse()).filter((entry) =>
			Device.passes(entry, input),
		);
		const limit = input.limit ?? 100;
		const base = { historyEpoch: 0, bootId: BOOT };
		const entries: LogEntry[] = [];
		const stop =
			cut === "end" ? examined.length : Math.min(cut, examined.length);
		for (let i = 0; i < stop; i += 1) {
			const entry = examined[i] as LogEntry;
			if (!Device.matches(entry, input)) continue;
			if (entries.length === limit)
				return {
					ok: true,
					...base,
					entries,
					hasMore: true,
					termination: "lookahead",
					continuation: `pos:${entries.at(-1)?.cursor}`,
				};
			entries.push(entry);
		}
		if (stop < examined.length) {
			const last = examined[stop - 1];
			return {
				ok: true,
				...base,
				entries,
				hasMore: null,
				termination: "budget",
				continuation:
					last === undefined
						? (input.continuation ?? null)
						: `pos:${last.cursor}`,
			};
		}
		return {
			ok: true,
			...base,
			entries,
			hasMore: false,
			termination: "end",
			continuation: null,
		};
	}

	pendingWork(): boolean {
		const follower = this.follower;
		return (
			this.queries.length > 0 ||
			this.starts.length > 0 ||
			this.stops.length > 0 ||
			this.late.length > 0 ||
			(follower !== null &&
				this.journal
					.slice(follower.examined + 1)
					.some(
						(entry, i) =>
							follower.examined + 1 + i >= this.floor &&
							Device.passes(entry, follower.filter),
					))
		);
	}
}

/** Reply chains in RawView are a few awaits deep; this drains them all. */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 60; tick += 1) await Promise.resolve();
}

type Setup =
	| "budget0-follow"
	| "end-follow"
	| "budget0-idle"
	| "budget1-follow"
	| "text-budget0-follow"
	| "empty-idle"
	| "blank-idle"
	| "end-idle"
	| "anchor-exact"
	| "anchor-approximate"
	| "oldest";

interface Scenario {
	readonly setup: Setup;
	/** How the scheduler cuts pages answered by R events. */
	readonly cut: Cut;
	readonly events: readonly string[];
	readonly manualStart?: boolean;
	readonly manualStop?: boolean;
	/** The write at this journal index is recorded 10 s early: a real clock step. */
	readonly step?: number;
}

interface Violation {
	readonly at: number;
	readonly event: string;
	readonly invariant: string;
	readonly detail: string;
}

const keyOf = (row: RawRow) => row.key;
const entriesOf = (rows: readonly RawRow[]) =>
	rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : []));

function aroundPage(device: Device, approximate: boolean): AroundPage {
	const at = device.index("anchor");
	const anchor = device.journal[at] as LogEntry;
	const side = {
		ok: true as const,
		entries: [],
		hasMore: null,
		termination: "budget" as const,
		historyEpoch: 0,
		bootId: BOOT,
	};
	const query: Omit<AroundPage["olderQuery"], "direction"> = {
		sources: [],
		levels: ["error", "warning", "info"],
		boot: BOOT,
		limit: 50,
	};
	return {
		ok: true,
		anchor: approximate ? null : anchor,
		approximate,
		older: {
			...side,
			continuation: approximate ? null : `pos:${anchor.cursor}`,
		},
		newer: {
			...side,
			continuation: approximate ? null : `pos:${anchor.cursor}`,
		},
		olderQuery: {
			...query,
			direction: "older",
			...(approximate ? { until: anchor.ts } : {}),
		},
		newerQuery: {
			...query,
			direction: "newer",
			...(approximate ? { since: anchor.ts + 1 } : {}),
		},
	};
}

/** Replays one scenario and returns every invariant it breaks. */
async function replay(scenario: Scenario): Promise<Violation[]> {
	const device = new Device();
	let now = T0;
	/** The newest start owns the socket's follow (follow.ts stops the older one) and the listener slot. */
	let lastStarter = null as "old" | "next" | null;
	let oldStops = 0;
	let oldListens = 0;
	const view = new RawView({
		logs: {
			...device.logs,
			followStart: (input: LogFollowStartInput) => {
				lastStarter = "old";
				return device.logs.followStart(input);
			},
			followStop: () => {
				oldStops += 1;
				return device.logs.followStop();
			},
		},
		setFollowListener: (listener) => {
			oldListens += 1;
			device.listener = listener;
		},
		now: () => now,
	});
	/** A view mounted later (Nv) on the same socket and listener slot, as when the tab is reopened. */
	let next = null as RawView | null;
	let nextListener: ((message: LogFollowMessage) => void) | undefined;
	let nextFollower = null as Follower | null;
	const mount = () =>
		new RawView({
			logs: {
				...device.logs,
				followStart: (input: LogFollowStartInput) => {
					lastStarter = "next";
					const out = device.logs.followStart(input);
					nextFollower = device.follower;
					return out;
				},
			},
			setFollowListener: (listener) => {
				nextListener = listener ?? nextListener;
				device.listener = listener;
			},
			now: () => now,
		});
	const violations: Violation[] = [];
	const seen = new Set<string>();
	const fail = (
		at: number,
		event: string,
		invariant: string,
		detail: string,
	) => {
		if (seen.has(invariant)) return;
		seen.add(invariant);
		violations.push({ at, event, invariant, detail });
	};
	/** Answers every reply the setup's own steps are waiting for. */
	const settleSetup = async (cut: Cut) => {
		for (let round = 0; round < 20; round += 1) {
			await settle();
			const progress =
				device.starts.length + device.stops.length + device.queries.length > 0;
			device.starts.shift()?.();
			device.stops.shift()?.();
			device.answer(cut);
			if (!progress) break;
		}
		await settle();
	};

	// Setup: the journal, the first page and, for some families, a running Follow.
	const { setup } = scenario;
	if (setup === "budget1-follow") {
		device.write("old1");
		device.write("old2");
	} else if (setup.startsWith("anchor"))
		for (const cursor of ["o2", "o1", "anchor", "n1", "n2"])
			device.write(cursor);
	else if (setup === "empty-idle") device.write("noise", { level: "debug" });
	else if (setup !== "blank-idle") device.write("old");
	if (setup.startsWith("anchor"))
		await view.start(aroundPage(device, setup === "anchor-approximate"));
	else {
		const firstCut: Cut =
			setup === "end-follow" ||
			setup === "end-idle" ||
			setup === "empty-idle" ||
			setup === "blank-idle"
				? "end"
				: setup === "budget1-follow"
					? 1
					: 0;
		if (setup === "text-budget0-follow") view.setDraft(MATCH);
		const first =
			setup === "oldest"
				? view.setOrder("oldest")
				: setup === "text-budget0-follow"
					? view.applyDraft()
					: view.start();
		await settleSetup(firstCut);
		await first;
		if (setup.endsWith("-follow")) {
			const follow = view.startFollow();
			await settleSetup(firstCut);
			await follow;
		}
	}
	device.manualStart = scenario.manualStart ?? false;
	device.manualStop = scenario.manualStop ?? false;

	const newestFirst = () => view.newestFirst;
	const listed = () => [...view.held, ...view.rows];
	const scope = () => ({
		levels:
			view.filter.level === "errors"
				? (["error"] as LogLevel[])
				: view.filter.level === "everything"
					? (["error", "warning", "info", "debug"] as LogLevel[])
					: (["error", "warning", "info"] as LogLevel[]),
		text: view.filter.text,
	});
	const matching = () =>
		device.journal
			.slice(device.floor)
			.filter((entry) => Device.matches(entry, scope()));
	const state = () =>
		JSON.stringify({
			rows: view.rows.map(keyOf),
			held: view.held.map(keyOf),
			bottom: view.bottom,
			top: view.top,
			failure: view.failure,
			follow: view.follow,
		});

	let away = false;
	let pinned: string | undefined;
	let disposed = false;
	let level: "info" | "everything" = "info";

	/** The journal run a marker row speaks for, as matching entry indices. */
	const runOf = (rows: readonly RawRow[], i: number): [number, number] => {
		const row = rows[i] as RawRow;
		const near = (step: 1 | -1) => {
			for (let j = i + step; j >= 0 && j < rows.length; j += step) {
				const other = rows[j] as RawRow;
				if (other.kind === "entry") return device.index(other.entry.cursor);
			}
			return undefined;
		};
		const [newerSide, olderSide] = newestFirst()
			? [near(-1), near(1)]
			: [near(1), near(-1)];
		if (
			row.kind === "marker" &&
			row.marker === "dropped" &&
			!row.key.startsWith("dropped-held")
		) {
			const below = rows[i + 1];
			const run =
				below?.kind === "entry"
					? device.sent.get(below.entry.cursor)
					: undefined;
			if (run !== undefined) return [run.from, run.to];
		}
		return [
			(olderSide ?? device.floor - 1) + 1,
			(newerSide ?? device.journal.length) - 1,
		];
	};

	const check = (at: number, event: string) => {
		const rows = listed();
		// I1: one row per key.
		const keys = rows.map(keyOf);
		if (new Set(keys).size !== keys.length)
			fail(at, event, "I1 identity", `repeated key in ${keys.join(",")}`);
		// I2: entries follow journal order in the view's direction.
		const positions = entriesOf(rows).map((entry) =>
			device.index(entry.cursor),
		);
		const sign = newestFirst() ? -1 : 1;
		const ordered = positions.every(
			(position, i) =>
				position >= device.floor &&
				(i === 0 ||
					Math.sign(position - (positions[i - 1] as number)) === sign),
		);
		if (!ordered)
			fail(at, event, "I2 journal order", `listed ${keys.join(",")}`);
		// I3 by runs, within held and within shown: every missing entry lies in a
		// marker's run, a dropped marker's run misses exactly its count, and no
		// marker's run is complete.
		const listedSet = new Set(entriesOf(rows).map((entry) => entry.cursor));
		const want = matching();
		const missingIn = (low: number, high: number) =>
			want.filter((entry) => {
				const index = device.index(entry.cursor);
				return index >= low && index <= high && !listedSet.has(entry.cursor);
			});
		const parts: readonly (readonly RawRow[])[] = [view.held, view.rows];
		const marked = new Set<string>();
		for (const part of parts) {
			const claimed = new Set<string>();
			part.forEach((row: RawRow, i: number) => {
				if (row.kind !== "marker") return;
				const [low, high] = runOf(part, i);
				const missing = missingIn(low, high);
				for (const entry of missing) {
					claimed.add(entry.cursor);
					marked.add(entry.cursor);
				}
				if (row.marker === "dropped" && missing.length === 0)
					fail(at, event, "I3 markers", `marker ${row.key} states no hole`);
				if (row.marker === "dropped" && missing.length !== row.count)
					fail(
						at,
						event,
						"I3 markers",
						`marker ${row.key} counts ${row.count}, its run misses ${missing.length}`,
					);
			});
			const entries = entriesOf(part).map((entry) =>
				device.index(entry.cursor),
			);
			for (let i = 1; i < entries.length; i += 1) {
				const [low, high] =
					sign < 0
						? [entries[i] as number, entries[i - 1] as number]
						: [entries[i - 1] as number, entries[i] as number];
				const silent = missingIn(low + 1, high - 1).filter(
					(entry) => !claimed.has(entry.cursor),
				);
				if (silent.length > 0)
					fail(
						at,
						event,
						"I3 markers",
						`unmarked hole ${silent.map((entry) => entry.cursor).join(",")}`,
					);
			}
		}
		const follower = device.follower;
		if (follower !== null) {
			// I4: an attached Follow stands at or after the newest listed entry, and no head query runs meanwhile.
			const newest = Math.max(-1, ...positions);
			if (newest > follower.published)
				fail(
					at,
					event,
					"I4 follow attaches at the top",
					`follower at ${follower.published}, newest listed ${newest}`,
				);
			if (
				device.queries.some((query) => query.input.continuation === undefined)
			)
				fail(
					at,
					event,
					"I4 follow attaches at the top",
					"a head query runs while Follow is attached",
				);
			// I9: the Follow the view keeps never starts above an unmarked entry the last head read missed.
			const read = device.headRead;
			if (read !== null && follower.replied && follower.start >= read) {
				const skipped = want.filter((entry) => {
					const index = device.index(entry.cursor);
					return (
						index >= read &&
						index <= follower.start &&
						!listedSet.has(entry.cursor) &&
						!marked.has(entry.cursor)
					);
				});
				if (skipped.length > 0)
					fail(
						at,
						event,
						"I9 no skipped start",
						`Follow starts after ${skipped.map((entry) => entry.cursor).join(",")}`,
					);
			}
		}
		// I5: while reading away from the top or with entries held, the first shown row stays.
		if (away || view.held.length > 0) {
			if (pinned === undefined) pinned = view.rows[0]?.key;
			else if (keys.includes(pinned) && view.rows[0]?.key !== pinned)
				fail(
					at,
					event,
					"I5 reading position",
					`first shown ${view.rows[0]?.key}, was ${pinned}`,
				);
		} else pinned = undefined;
		// I6: clock rows exactly where the journal-newer of two shown neighbours has the smaller time.
		const shownEntries = entriesOf(view.rows);
		const expectedClocks = shownEntries.slice(1).flatMap((entry, i) => {
			const prior = shownEntries[i] as LogEntry;
			const [older, newer] =
				device.index(prior.cursor) < device.index(entry.cursor)
					? [prior, entry]
					: [entry, prior];
			return newer.ts < older.ts ? [`clock-${entry.cursor}`] : [];
		});
		const clocks = displayRows(view.rows, newestFirst())
			.filter((row) => row.kind === "clock")
			.map((row) => row.key);
		if (JSON.stringify(clocks) !== JSON.stringify(expectedClocks))
			fail(
				at,
				event,
				"I6 honest clock rows",
				`clock rows ${clocks.join(",")}, journal says ${expectedClocks.join(",")}`,
			);
	};

	const act = (event: string): Query | undefined => {
		const ui = !disposed;
		const burst = (count: number, patch: Parameters<Device["write"]>[1]) => {
			for (let i = 0; i < count; i += 1) device.writeNext(patch);
		};
		switch (event) {
			case "W":
				device.writeNext(
					scenario.step === device.journal.length
						? { ts: T0 + (device.journal.length - 10) * 1000 }
						: {},
				);
				break;
			case "We":
				device.writeNext({ level: "error" });
				break;
			case "Wd":
				device.writeNext({ level: "debug" });
				break;
			case "Wt":
				device.writeNext({ text: "skip" });
				break;
			case "Wt3":
				burst(3, { text: "skip" });
				break;
			case "Wb":
				burst(501, {});
				break;
			case "W200":
				burst(200, {});
				break;
			// 16 records with 16 KiB messages: the batch keeps 15 and drops the 16th.
			case "W16":
				burst(16, { size: LARGE });
				break;
			// The 16th large record is dropped and a small one after it still fits.
			case "W16m":
				burst(16, { size: LARGE });
				device.writeNext();
				break;
			// Like W16, with a record the text search rejects examined last.
			case "W16r":
				burst(16, { size: LARGE });
				device.writeNext({ text: "skip" });
				break;
			case "D":
				device.flush();
				break;
			case "D1":
				device.flush(true);
				break;
			case "S":
				device.snapshot();
				break;
			case "R":
				return device.answer(scenario.cut);
			case "St":
				device.starts.shift()?.();
				break;
			case "Ps":
				device.stops.shift()?.();
				break;
			case "Dl":
				device.lateFlush = true;
				break;
			case "O":
				device.end("follower_exit");
				break;
			case "E":
				device.end("cleared");
				break;
			case "N":
				device.disconnect();
				if (ui) view.connectionChanged("disconnected");
				break;
			case "C":
				device.connected = true;
				if (ui) view.connectionChanged("connected");
				break;
			case "K":
				if (ui) void view.loadMore("bottom");
				break;
			case "Kt":
				if (ui) void view.loadMore("top");
				break;
			case "Z":
				if (ui) void view.reset();
				break;
			case "F":
				// The button is disabled while busy, blocked or offline; it pauses while following.
				if (
					ui &&
					view.connected &&
					view.followBlocked === null &&
					!view.followBusy &&
					view.follow !== "following"
				)
					void view.startFollow();
				break;
			case "P":
				if (ui && view.follow === "following" && !view.followBusy)
					void view.pauseFollow();
				break;
			case "Aw":
				if (ui) view.setAtTop(false);
				away = ui;
				break;
			case "T":
				if (ui) view.setAtTop(true);
				away = false;
				break;
			case "V":
				if (ui && view.held.length > 0) {
					view.showHeld();
					away = false;
					pinned = undefined;
				}
				break;
			case "X":
				level = level === "info" ? "everything" : "info";
				if (ui) void view.setLevel(level);
				break;
			case "Xe":
				if (ui) void view.setLevel("errors");
				break;
			case "U":
				if (ui) view.dispose();
				disposed = true;
				break;
			// The old view is disposed again, whatever its state.
			case "U2":
				view.dispose();
				break;
			case "Nv":
				next = mount();
				void next.start();
				break;
			case "Fn":
				if (
					next !== null &&
					next.followBlocked === null &&
					!next.followBusy &&
					next.follow !== "following"
				)
					void next.startFollow();
				break;
			default:
				throw new Error(`unknown event ${event}`);
		}
		return undefined;
	};

	// I10: while the replacement holds the newest start, its follower and listener stay its own.
	const owned = (at: number, event: string) => {
		if (next === null || lastStarter !== "next") return;
		if (next.follow === "following" && device.follower !== nextFollower)
			fail(
				at,
				event,
				"I10 one owner",
				"the replacement's follower was stopped",
			);
		if (
			(next.follow === "following" || next.follow === "starting") &&
			device.listener !== nextListener
		)
			fail(
				at,
				event,
				"I10 one owner",
				"the replacement's listener was cleared",
			);
	};

	for (const [at, event] of scenario.events.entries()) {
		const before = state();
		const generation = device.era;
		const stops = oldStops;
		const listens = oldListens;
		// A reset clears the list and starts a new generation of replies.
		if (["X", "Xe", "Z", "U", "E"].includes(event)) pinned = undefined;
		if (["X", "Xe", "Z", "U"].includes(event) && !disposed) device.era += 1;
		if (event === "E" && device.follower !== null) device.era += 1;
		const answered = act(event);
		await settle();
		now += 1000;
		// I7: a stale reply, or anything after dispose, changes nothing.
		if (
			(answered !== undefined && answered.era < generation) ||
			(disposed && event !== "U")
		)
			if (state() !== before)
				fail(at, event, "I7 staleness", `${before} -> ${state()}`);
		if (event === "U2" && (oldStops !== stops || oldListens !== listens))
			fail(
				at,
				event,
				"I10 one dispose",
				`a second dispose sent ${oldStops - stops} stops and set the listener ${oldListens - listens} times`,
			);
		// The old view's own checks assume the device's follower is its own, so they stop at a replacement.
		if (!disposed && next === null) check(at, event);
		owned(at, event);
	}

	const end = scenario.events.length;
	// The view settles before each look at the device: a resolved reply may still owe it a request.
	const drain = async () => {
		for (let round = 0; round < 50; round += 1) {
			await settle();
			if (!device.pendingWork()) break;
			device.deliverLate();
			device.starts.shift()?.();
			device.stops.shift()?.();
			device.answer("end");
			device.flush();
		}
		await settle();
	};
	// End check: drain every reply, reveal, follow and page to both ends (I8).
	if (!disposed) {
		device.manualStart = false;
		device.manualStop = false;
		await drain();
		if (!device.connected) {
			device.connected = true;
			view.connectionChanged("connected");
		}
		if (view.failure !== null) {
			void view.retry();
			await drain();
		}
		if (view.held.length > 0) view.showHeld();
		view.setAtTop(true);
		away = false;
		pinned = undefined;
		if (view.followBlocked === null && view.follow !== "following") {
			void view.startFollow();
			await drain();
		}
		for (const edge of ["bottom", "top"] as const) {
			for (let click = 0; click < 12; click += 1) {
				const at = view[edge];
				if (
					at === null ||
					at.hasMore === false ||
					at.lost ||
					(edge === "bottom" && view.capped)
				)
					break;
				const asked = device.queries.length;
				void view.loadMore(edge);
				if (device.queries.length !== asked + 1)
					fail(
						end,
						`${edge} control`,
						"I8 liveness",
						`a click on the ${edge} control issued ${device.queries.length - asked} queries`,
					);
				await drain();
			}
			const at = view[edge];
			if (
				at !== null &&
				at.hasMore !== false &&
				!at.lost &&
				!(edge === "bottom" && view.capped)
			)
				fail(
					end,
					`${edge} control`,
					"I8 liveness",
					`${edge} still pages after 12 clicks`,
				);
		}
		await drain();
		check(end, "end");
		const listedEntries = new Set(
			entriesOf(listed()).map((entry) => entry.cursor),
		);
		const markers = listed().filter((row) => row.kind === "marker").length;
		const missing = matching().filter(
			(entry) => !listedEntries.has(entry.cursor),
		);
		if (missing.length > 0 && markers === 0)
			fail(
				end,
				"end",
				"end: nothing lost",
				`missing ${missing.map((entry) => entry.cursor).join(",")}`,
			);
	}
	// End check for a replacement (I10): it follows and receives the next write.
	if (next !== null) {
		device.manualStart = false;
		device.manualStop = false;
		await drain();
		if (next.follow !== "following") {
			void next.startFollow();
			await drain();
		}
		owned(end, "end");
		if (lastStarter === "next") {
			device.writeNext();
			const cursor = device.journal.at(-1)?.cursor;
			await drain();
			if (!entriesOf(next.rows).some((entry) => entry.cursor === cursor))
				fail(
					end,
					"end",
					"I10 the replacement follows",
					`${cursor} never reached it`,
				);
		}
		next.dispose();
	}
	view.dispose();
	return violations;
}

/** Every interleaving of the chains, each keeping its own order. */
function interleavings(chains: readonly (readonly string[])[]): string[][] {
	const out: string[][] = [];
	const at = chains.map(() => 0);
	const walk = (prefix: string[]) => {
		let done = true;
		chains.forEach((chain, i) => {
			const next = chain[at[i] as number];
			if (next === undefined) return;
			done = false;
			at[i] = (at[i] as number) + 1;
			prefix.push(next);
			walk(prefix);
			prefix.pop();
			at[i] = (at[i] as number) - 1;
		});
		if (done) out.push([...prefix]);
	};
	walk([]);
	return out;
}

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const label = (scenario: Scenario) =>
	`${scenario.setup} cut=${scenario.cut}${scenario.step === undefined ? "" : ` step=${scenario.step}`}${scenario.manualStart ? " manualStart" : ""}${scenario.manualStop ? " manualStop" : ""}: ${scenario.events.join(" ")}`;

/** Replays every scenario and fails on the first one that breaks an invariant. */
async function family(scenarios: Iterable<Scenario>): Promise<number> {
	let count = 0;
	for (const scenario of scenarios) {
		const violations = await replay(scenario);
		count += 1;
		if (violations.length > 0)
			expect({ scenario: label(scenario), violations }).toEqual({
				scenario: label(scenario),
				violations: [],
			});
	}
	return count;
}

/** Inserts `Aw` before the k-th occurrence of `event`, or nowhere when k is past the last. */
function awayBefore(
	events: readonly string[],
	event: string,
	k: number,
): string[] {
	const out = [...events];
	let seen = -1;
	const at = out.findIndex((name) => name === event && ++seen === k);
	if (at >= 0) out.splice(at, 0, "Aw");
	return out;
}

/** F1 orders: three writes, three flushes and a replay, Aw before the k-th flush or not at all. */
function* f1(cuts: readonly Cut[]): Generator<Scenario> {
	const orders = interleavings([
		["W", "W", "W"],
		["D", "D", "D"],
		["K", "S", "R"],
	]);
	for (const cut of cuts)
		for (const order of orders)
			for (let away = 0; away < 4; away += 1)
				yield {
					setup: "budget0-follow",
					cut,
					events: [...awayBefore(order, "D", away), "V"],
				};
}

const witness = (scenario: Scenario) => async () => {
	expect(await replay(scenario)).toEqual([]);
};

describe("RawView — event orders against a device that replies like the backend", () => {
	it(
		"witness R1: Keep searching after a zero-record budget page reaches the end",
		witness({ setup: "budget0-follow", cut: "end", events: [] }),
	);
	it(
		"witness R2: a replay that read ahead of Follow keeps journal order",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: ["W", "D", "W", "K", "S", "R", "D"],
		}),
	);
	it(
		"witness R3: entries held while away keep their place in the replayed page",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: ["W", "D", "Aw", "W", "D", "W", "K", "S", "R", "D", "V"],
		}),
	);
	it(
		"witness R3 with 40 followed rows",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: [
				...Array.from({ length: 40 }, () => "W"),
				"D",
				"Aw",
				"W",
				"D",
				"W",
				"K",
				"S",
				"R",
				"D",
				"V",
			],
		}),
	);
	it(
		"witness R3 disjoint: a 100-entry replay with nothing in common with the shown row",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: [
				"W",
				"D",
				...Array.from({ length: 101 }, () => "W"),
				"K",
				"S",
				"R",
				"D",
				"V",
			],
		}),
	);
	it(
		"witness L1: a budget-cut head page that read ahead of Follow keeps journal order",
		witness({
			setup: "budget0-follow",
			cut: 1,
			events: ["W", "W", "K", "S", "R", "D"],
		}),
	);
	it(
		"witness L2: Resume after Start from newest continues from the new page",
		witness({
			setup: "end-follow",
			cut: 1,
			manualStop: true,
			events: ["P", "Ps", "W", "W", "Z", "S", "R", "F", "D"],
		}),
	);
	it(
		"witness L3: Follow cannot start while a head query runs",
		witness({
			setup: "budget0-idle",
			cut: 1,
			manualStart: true,
			events: ["K", "F", "St", "W", "W", "S", "R", "D"],
		}),
	);
	it(
		"witness L4: a replay while away does not move the row being read",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: ["W", "D", "Aw", "W", "K", "S", "R"],
		}),
	);
	it(
		"witness W1: an entry written after the head read comes through Follow above it",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: ["W", "K", "S", "W", "R", "D"],
		}),
	);
	it(
		"witness W2: an entry Follow showed before a shorter head read comes back below it",
		witness({
			setup: "budget0-follow",
			cut: 1,
			events: ["W", "D", "W", "K", "S", "R"],
		}),
	);
	it(
		"witness Case 1: a replay that fills a Follow pressure drop keeps journal order",
		witness({
			setup: "budget0-follow",
			cut: 2,
			events: ["W16", "D", "W", "D", "K", "S", "R"],
		}),
	);
	it(
		"witness Case 1 interleaved: a small record kept after a dropped large one",
		witness({
			setup: "budget0-follow",
			cut: 2,
			events: ["W16m", "D", "W", "D", "K", "S", "R"],
		}),
	);
	it(
		"witness H0: an empty replay does not rewind Follow into dropped entries",
		witness({
			setup: "budget0-follow",
			cut: 0,
			events: ["W16", "D", "K", "S", "R", "D"],
		}),
	);
	it(
		"witness He: a dropped marker cut by the held cap is counted once",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: [
				"W",
				"D",
				"Aw",
				"W16",
				"D",
				"W200",
				"D",
				"W200",
				"D",
				"W200",
				"D",
				"V",
			],
		}),
	);
	it(
		"witness Case 2: Follow after Clear and an empty page shows what was written after the read",
		witness({
			setup: "budget0-follow",
			cut: "end",
			events: ["E", "S", "R", "W", "F"],
		}),
	);
	it(
		"witness E1: Follow on a view that mounted empty shows an entry written since",
		witness({ setup: "empty-idle", cut: "end", events: ["W", "F"] }),
	);
	it(
		"witness E1 null head: Follow on an empty boot keeps its first subscription",
		witness({
			setup: "blank-idle",
			cut: "end",
			manualStart: true,
			events: ["F", "W", "D", "St", "W", "D"],
		}),
	);
	it(
		"witness E2: a filter change to an empty result keeps an error written during the refollow",
		witness({
			setup: "end-follow",
			cut: "end",
			manualStart: true,
			events: ["Xe", "S", "We", "R", "St", "S", "R", "St", "D"],
		}),
	);
	it(
		"witness E3: a disconnect during the bootstrap read leaves Resume to bootstrap again",
		witness({
			setup: "empty-idle",
			cut: "end",
			events: ["W", "F", "N", "C", "W", "F"],
		}),
	);
	it(
		"witness C0: Clear logs while a Follow start waits for its reply leaves nothing the device removed",
		witness({
			setup: "end-follow",
			cut: "end",
			manualStart: true,
			events: ["P", "F", "E", "St", "D"],
		}),
	);
	it(
		"witness limbo: Follow never runs over an empty search that has a position",
		witness({
			setup: "text-budget0-follow",
			cut: 1,
			events: ["W", "D", "K", "W", "W", "Wt", "S", "R", "D1", "K", "S", "R"],
		}),
	);
	it(
		"witness: a real clock step is marked exactly once after a replay",
		witness({
			setup: "budget0-follow",
			cut: "end",
			step: 2,
			events: ["W", "D", "W", "W", "K", "S", "R", "D"],
		}),
	);

	it("F1: 1,680 head-replay and Follow orders x 4 held positions x 2 page cuts", async () => {
		expect(await family(f1(["end", 1]))).toBe(13_440);
	});

	it("F2: Pause, Start from newest and Resume in every order", async () => {
		const orders = interleavings([
			["P", "Ps", "F"],
			["W", "W"],
			["Z", "S", "R"],
			["D"],
		]);
		const scenarios = (["end", 1] as const).flatMap((cut) =>
			orders.map(
				(events): Scenario => ({
					setup: "end-follow",
					cut,
					manualStop: true,
					events,
				}),
			),
		);
		expect(await family(scenarios)).toBe(10_080);
	});

	it("F3: Follow clicked while a head query runs, in every order", async () => {
		const orders = interleavings([
			["F", "St"],
			["K", "S", "R"],
			["W", "W"],
			["D"],
		]);
		const scenarios = (["end", 1] as const).flatMap((cut) =>
			orders.map(
				(events): Scenario => ({
					setup: "budget0-idle",
					cut,
					manualStart: true,
					events,
				}),
			),
		);
		expect(await family(scenarios)).toBe(3_360);
	});

	it("F4: positioned paging stays an edge merge while Follow runs", async () => {
		const orders = interleavings([["W"], ["D"], ["K", "S", "R"], ["Aw"]]);
		const scenarios = (["end", 1] as const).flatMap((cut) =>
			orders.map(
				(events): Scenario => ({
					setup: "budget1-follow",
					cut,
					events: [...events, "V"],
				}),
			),
		);
		expect(await family(scenarios)).toBe(240);
	});

	it("F5: anchor sides in either order, and Oldest first", async () => {
		const sides = interleavings([
			["Kt", "S", "R"],
			["K", "S", "R"],
		]);
		const scenarios: Scenario[] = [
			...sides.map(
				(events): Scenario => ({ setup: "anchor-exact", cut: 0, events }),
			),
			...sides.map(
				(events): Scenario => ({ setup: "anchor-approximate", cut: 0, events }),
			),
			{ setup: "oldest", cut: 1, events: ["W", "K", "S", "R"] },
		];
		expect(await family(scenarios)).toBe(41);
	});

	it("F6: a filter change, unmount, disconnect, Clear logs, follower exit or late batch at any point", async () => {
		const base = [...f1(["end", 1])];
		const random = mulberry32(30);
		const extra = ["X", "U", "N", "E", "O", "Dl"];
		const scenarios = Array.from({ length: 2000 }, (): Scenario => {
			const pick = base[Math.floor(random() * base.length)] as Scenario;
			const events = [...pick.events];
			events.splice(
				Math.floor(random() * (events.length + 1)),
				0,
				extra[Math.floor(random() * extra.length)] as string,
			);
			return { ...pick, events };
		});
		expect(await family(scenarios)).toBe(2000);
	});

	it("F7: 300 random walks of 30 events over the whole alphabet", async () => {
		const alphabet = [
			"W",
			"W",
			"D",
			"D1",
			"W16",
			"W16m",
			"K",
			"S",
			"R",
			"R",
			"Z",
			"F",
			"P",
			"Ps",
			"St",
			"Aw",
			"T",
			"V",
			"X",
			"N",
			"C",
			"O",
			"Dl",
			"Wd",
			"We",
		];
		const setups: Setup[] = [
			"budget0-follow",
			"end-follow",
			"budget1-follow",
			"budget0-idle",
			"text-budget0-follow",
			"empty-idle",
		];
		const scenarios = Array.from({ length: 300 }, (_, walk): Scenario => {
			const random = mulberry32(1000 + walk);
			const events = Array.from(
				{ length: 30 },
				() => alphabet[Math.floor(random() * alphabet.length)] as string,
			);
			if (walk % 10 === 0) events.splice(5, 0, "Aw", "Wb", "D", "D", "D");
			return {
				setup: setups[walk % setups.length] as Setup,
				cut: walk % 3 === 0 ? "end" : walk % 3,
				manualStart: walk % 2 === 0,
				manualStop: walk % 4 < 2,
				...(walk % 5 === 0 ? { step: 3 } : {}),
				events,
			};
		});
		expect(await family(scenarios)).toBe(300);
	});

	it("F8: Follow pressure drops x a head replay, every order and cut", async () => {
		const scenarios: Scenario[] = [];
		for (const drop of ["W16", "W16m", "W16r"])
			for (const order of interleavings([
				[drop, "D"],
				["W", "D"],
				["K", "S", "R"],
			]))
				for (const away of [3, 0, 1])
					for (const cut of [0, 1, 2, 3, 16, "end"] as const)
						scenarios.push({
							setup: drop === "W16r" ? "text-budget0-follow" : "budget0-follow",
							cut,
							events: [...awayBefore(order, "D", away), "D", "V"],
						});
		expect(await family(scenarios)).toBe(11_340);
	});

	it("F9: Follow on an empty page, after Clear and after a filter change to nothing", async () => {
		const prefixes: [Setup, readonly string[]][] = [
			["empty-idle", []],
			["blank-idle", []],
			["end-follow", ["E", "S", "R"]],
			["end-follow", ["Xe", "S", "R", "St", "S", "R", "St"]],
		];
		const orders = interleavings([
			["F", "St", "S", "R", "St"],
			["W", "W"],
			["Wd"],
		]);
		const scenarios = prefixes.flatMap(([setup, prefix]) =>
			orders.map(
				(events): Scenario => ({
					setup,
					cut: "end",
					manualStart: true,
					events: [...prefix, ...events, "D"],
				}),
			),
		);
		const random = mulberry32(90);
		const extra = ["N", "C", "U", "X", "E"];
		const seeded = Array.from({ length: 2000 }, (): Scenario => {
			const pick = scenarios[
				Math.floor(random() * scenarios.length)
			] as Scenario;
			const events = [...pick.events];
			events.splice(
				Math.floor(random() * (events.length + 1)),
				0,
				extra[Math.floor(random() * extra.length)] as string,
			);
			return { ...pick, events };
		});
		expect(await family([...scenarios, ...seeded])).toBe(2672);
	});

	it("F10: an empty search with a position while Follow would run", async () => {
		const orders = interleavings([
			["W", "D"],
			["Wt3"],
			["K", "S", "R"],
			["P", "Ps", "F"],
		]);
		const scenarios = ([1, 2, 4] as const).flatMap((cut) =>
			orders.map(
				(events): Scenario => ({
					setup: "text-budget0-follow",
					cut,
					manualStop: true,
					events: [...events, "K", "S", "R"],
				}),
			),
		);
		expect(await family(scenarios)).toBe(15_120);
	});

	it(
		"witness D1: a second dispose after the replacement view follows",
		witness({
			setup: "end-follow",
			cut: "end",
			events: ["U", "Nv", "R", "Fn", "U2", "W", "D"],
		}),
	);
	it(
		"witness D2: a second dispose while the old start is pending",
		witness({
			setup: "end-idle",
			cut: "end",
			manualStart: true,
			events: ["F", "U", "Nv", "R", "Fn", "U2", "St", "St", "W", "D"],
		}),
	);
	it(
		"witness D3: one dispose after a newer view started Follow",
		witness({
			setup: "end-follow",
			cut: "end",
			events: ["Nv", "R", "Fn", "U", "W", "D"],
		}),
	);

	it("F12: dispose twice x a replacement view x a pending start or a replay, every order", async () => {
		const mountAndFollow = ["Nv", "R", "Fn"];
		const families: [Setup, boolean, readonly (readonly string[])[]][] = [
			["end-follow", false, [["U", "U2"], mountAndFollow, ["W", "D"]]],
			["end-idle", true, [["F", "U", "U2"], mountAndFollow, ["St", "St"]]],
			["budget0-follow", false, [["K", "U", "U2"], mountAndFollow, ["R"]]],
		];
		const scenarios = families.flatMap(([setup, manualStart, chains]) =>
			interleavings(chains).map(
				(order): Scenario => ({
					setup,
					cut: "end",
					manualStart,
					events: [...order, "W", "D"],
				}),
			),
		);
		expect(await family(scenarios)).toBe(210 + 560 + 140);
	});

	it("F11: the null-head bootstrap on an empty boot, every order", async () => {
		const scenarios: Scenario[] = [];
		for (const setup of ["blank-idle", "empty-idle"] as const)
			for (const writes of [
				["W", "W"],
				["W", "Wd"],
				["Wd", "W"],
				["Wd", "Wd"],
			])
				for (const cut of ["end", 0] as const)
					for (const order of interleavings([
						["F", "St", "S", "R", "St"],
						writes,
						["D"],
					]))
						scenarios.push({ setup, cut, manualStart: true, events: order });
		expect(await family(scenarios)).toBe(2688);
	});
});
