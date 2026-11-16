/**
 * State of one mounted Raw logs tab: its filter, rows, both paging ends,
 * anchor mode and the live follow. Data loads only in these methods, which
 * event handlers call; every reply is checked against the generation or follow
 * token it was requested under, so a stale reply changes nothing.
 */
import type {
	LogAroundOutput,
	LogErrorCode,
	LogFollowMessage,
	LogFollowStopOutput,
	LogQueryInput,
	LogQueryOutput,
	LogSource,
} from "@ceraui/rpc/schemas";

import type { TypedRPC } from "$lib/rpc/client";

import {
	DEFAULT_RAW_FILTER,
	followBlock,
	followInput,
	queryInput,
	type RawFilter,
	type RawLevel,
	type RawOrder,
	type RawTime,
	searchText,
} from "./raw-filter";
import {
	capRows,
	entryRows,
	followRows,
	marker,
	newestCursor,
	newRows,
	placeRows,
	type RawRow,
} from "./raw-rows";

type QueryPage = Extract<LogQueryOutput, { ok: true }>;
export type AroundPage = Extract<LogAroundOutput, { ok: true }>;
export type RawEnd = "bottom" | "top";
/** What Follow learned when it had no position: the device head, read past before attaching. */
interface Fence {
	readonly head: string;
	readonly announce: "following" | "resumed" | null;
}
export type FollowState =
	| "idle"
	| "starting"
	| "following"
	| "paused"
	| "stopped"
	| "disconnected";

export interface RawEdge {
	/** The query this end pages with: the tab's filter, or an anchor page's. */
	readonly query: LogQueryInput;
	readonly continuation: string | null;
	readonly hasMore: boolean | null;
	/** The device no longer stores this end's position. */
	readonly lost: boolean;
}

export interface RawFailure {
	readonly code: LogErrorCode;
	readonly op: "first" | RawEnd | "follow";
}

export interface RawAnnouncement {
	readonly kind:
		| "following"
		| "resumed"
		| "paused"
		| "stopped"
		| "gap"
		| "disconnected"
		| "newEntries";
	readonly count: number;
	readonly serial: number;
}

export interface RawViewDeps {
	readonly logs: Pick<TypedRPC["logs"], "query" | "followStart" | "followStop">;
	setFollowListener(
		listener: ((message: LogFollowMessage) => void) | undefined,
	): void;
	now(): number;
}

const SEARCH_DEBOUNCE_MS = 300;
const HELD_CAP = 500;
const NEW_ENTRIES_EVERY_MS = 5000;
const EXPIRED: ReadonlySet<LogErrorCode> = new Set([
	"CURSOR_UNAVAILABLE",
	"FILTER_CHANGED",
]);
const READ_FAILED = { ok: false, error: "READ_FAILED" } as const;

// A socket has one follow (a new start stops the socket's older one) and the app
// one follow listener, so only the view that made the latest start may stop the
// device's follower or clear the listener.
let followOwner: object | undefined;

async function settle<T>(
	call: () => Promise<T>,
	fallback: T,
	label: string,
): Promise<T> {
	try {
		return await call();
	} catch (error) {
		console.error(label, error);
		return fallback;
	}
}

export class RawView {
	filter = $state.raw<RawFilter>(DEFAULT_RAW_FILTER);
	draft = $state("");
	/** Held entries, then the rows shown: one list in journal order. */
	#list = $state.raw<RawRow[]>([]);
	/** Key of the first shown row while entries wait above it; null when none wait. */
	#shownFrom = $state<string | null>(null);
	readonly #boundary = $derived(
		this.#shownFrom === null
			? 0
			: this.#list.findIndex((row) => row.key === this.#shownFrom),
	);
	rows = $derived(this.#list.slice(this.#boundary));
	/** Entries waiting above the shown rows while the list is read away from the top. */
	held = $derived(this.#list.slice(0, this.#boundary));
	loading = $state<"first" | RawEnd | null>(null);
	bottom = $state.raw<RawEdge | null>(null);
	/** Only in anchor mode, where the list pages toward newer entries too. */
	top = $state.raw<RawEdge | null>(null);
	/** The row cap cut the bottom of the list, so it cannot page further. */
	capped = $state(false);
	anchor = $state.raw<{ cursor: string | null; approximate: boolean } | null>(
		null,
	);
	failure = $state.raw<RawFailure | null>(null);
	follow = $state<FollowState>("idle");
	ended = $state<NonNullable<LogFollowMessage["ended"]> | null>(null);
	followBusy = $state(false);
	connected = $state(true);
	announcement = $state.raw<RawAnnouncement | null>(null);

	followBlocked = $derived(followBlock(this.filter, this.anchor !== null));
	newestFirst = $derived(
		this.anchor !== null || this.filter.order === "newest",
	);
	/** Nothing shown may look fresh: the socket is down or cut the follow. */
	stale = $derived(!this.connected || this.follow === "disconnected");

	readonly #deps: RawViewDeps;
	#generation = 0;
	#followToken = 0;
	/** This view in `followOwner`: a token, so a disposed view is not kept alive by it. */
	readonly #owner = {};
	#subscription: string | null = null;
	#queued: LogFollowMessage[] | null = null;
	#checkpoint: string | null = null;
	#serial = 0;
	#heldDropped = 0;
	/** A head read has placed no entries yet: its first page with entries replaces the list. */
	#openChain = false;
	#atTop = true;
	#disposed = false;
	#debounce: ReturnType<typeof setTimeout> | undefined;
	#pendingNew = 0;
	#lastNewAt = Number.NEGATIVE_INFINITY;

	constructor(deps: RawViewDeps) {
		this.#deps = deps;
	}

	/** Runs the first query, or opens anchor mode on a `logs.around` result. */
	start(anchor?: AroundPage): Promise<void> {
		if (anchor === undefined) return this.#load(false);
		this.#openAnchor(anchor);
		return Promise.resolve();
	}

	setLevel(level: RawLevel): Promise<void> {
		return this.#apply({ level });
	}

	setSources(sources: readonly LogSource[]): Promise<void> {
		return this.#apply({ sources });
	}

	setTime(time: RawTime): Promise<void> {
		return this.#apply({ time, bootId: null });
	}

	/** A boot from the boot picker; `null` is "All boots". */
	chooseBoot(bootId: string | null): Promise<void> {
		return this.#apply(bootId === null ? { bootId, time: "all" } : { bootId });
	}

	setOrder(order: RawOrder): Promise<void> {
		return this.#apply({ order });
	}

	showCurrentBoot(): Promise<void> {
		return this.#apply({ time: "current", bootId: null });
	}

	resetFilters(): Promise<void> {
		this.draft = "";
		return this.#apply(DEFAULT_RAW_FILTER);
	}

	setDraft(text: string): void {
		this.draft = text;
		clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => {
			void this.applyDraft();
		}, SEARCH_DEBOUNCE_MS);
	}

	applyDraft(): Promise<void> {
		clearTimeout(this.#debounce);
		const text = searchText(this.draft);
		return text === this.filter.text
			? Promise.resolve()
			: this.#apply({ text });
	}

	clearSearch(): Promise<void> {
		this.draft = "";
		return this.applyDraft();
	}

	/** Back to the newest entries of the current filter, leaving anchor mode. */
	reset(): Promise<void> {
		return this.#load(false);
	}

	async loadMore(end: RawEnd): Promise<void> {
		const edge = this[end];
		if (
			edge === null ||
			edge.lost ||
			// A budget page that stopped before reading a record has no position: repeat this end's first query.
			(edge.continuation === null && edge.hasMore !== null) ||
			this.loading !== null ||
			(end === "bottom" && this.capped)
		)
			return;
		// A repeated first query reads the head again: Follow waits until a page with entries is placed.
		const head = edge.continuation === null && this.anchor === null;
		const live = head && this.#detachFollow();
		const generation = this.#generation;
		this.loading = end;
		this.failure = null;
		if (head) {
			this.followBusy = true;
			this.#openChain = true;
		}
		let input: LogQueryInput =
			edge.continuation === null
				? edge.query
				: { ...edge.query, continuation: edge.continuation };
		let result = await this.#query(input);
		// Follow never runs over an empty search that has a position, so while it waits the search reads on.
		while (
			live &&
			generation === this.#generation &&
			result.ok &&
			result.entries.length === 0 &&
			result.continuation !== null &&
			result.continuation !== input.continuation
		) {
			input = { ...edge.query, continuation: result.continuation };
			result = await this.#query(input);
		}
		if (generation !== this.#generation) return;
		this.loading = null;
		if (result.ok) this.#place(end, edge, result);
		else {
			this.failure = { code: result.error, op: end };
			if (EXPIRED.has(result.error)) this[end] = { ...edge, lost: true };
		}
		if (head) await this.#continueFollow(live, false);
	}

	retry(): Promise<void> {
		const op = this.failure?.op;
		if (op === "first") return this.#load(false);
		if (op === "follow") return this.startFollow();
		return op === undefined ? Promise.resolve() : this.loadMore(op);
	}

	/** Follow or Resume: from the last resumable position, else the newest row. */
	async startFollow(): Promise<void> {
		if (
			this.follow === "following" ||
			this.followBusy ||
			!this.connected ||
			this.followBlocked !== null
		)
			return;
		await this.#attach(
			this.follow === "paused" || this.follow === "disconnected"
				? "resumed"
				: "following",
		);
	}

	/** Attaches a device follow after the newest listed entry; `announce` names the change, if any. */
	async #attach(announce: Fence["announce"]): Promise<void> {
		if (this.#disposed) return;
		// Follow never runs over an empty search that has a position: the edge reads from the head again.
		if (
			this.#openChain &&
			this.bottom !== null &&
			this.bottom.continuation !== null
		)
			this.bottom = { ...this.bottom, continuation: null, hasMore: null };
		const token = ++this.#followToken;
		followOwner = this.#owner;
		this.follow = "starting";
		this.followBusy = true;
		this.ended = null;
		if (this.failure?.op === "follow") this.failure = null;
		this.#subscription = null;
		this.#queued = [];
		this.#deps.setFollowListener(this.#receive);
		const position = this.#checkpoint ?? newestCursor(this.#list);
		const input = followInput(this.filter, position);
		const reply = await settle(
			() => this.#deps.logs.followStart(input),
			READ_FAILED,
			"System Logs follow start failed:",
		);
		if (token !== this.#followToken) {
			// A start that lands after unmount still runs on the device.
			if (reply.ok && this.#disposed) void this.#stop();
			return;
		}
		const queued = this.#queued ?? [];
		this.#queued = null;
		this.followBusy = false;
		if (!reply.ok) {
			this.#forgetFollow();
			this.follow = "idle";
			this.failure = { code: reply.error, op: "follow" };
			return;
		}
		// With no position, an entry written since the last head read lies at or before the head
		// Follow just started after: read the head again, then attach. A null head is an empty boot,
		// and this follower already reads it from its start, so it stays.
		if (position === null && reply.checkpointCursor !== null)
			return this.#load(false, { head: reply.checkpointCursor, announce });
		this.#subscription = reply.subscriptionId;
		this.#checkpoint = reply.checkpointCursor ?? this.#checkpoint;
		this.follow = "following";
		if (announce !== null) this.#announce(announce, 0);
		for (const message of queued) this.#receive(message);
	}

	/** Batches sent before the device confirms the stop still apply. */
	async pauseFollow(): Promise<void> {
		if (this.follow !== "following" || this.followBusy) return;
		const token = this.#followToken;
		this.follow = "paused";
		this.followBusy = true;
		this.#announce("paused", 0);
		const reply = await this.#stop();
		if (token !== this.#followToken) return;
		this.#checkpoint = reply?.checkpointCursor ?? this.#checkpoint;
		this.#forgetFollow();
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

	/** The device stops a socket's follow when the socket drops. */
	connectionChanged(state: string): void {
		const connected = state === "connected";
		if (connected === this.connected) return;
		this.connected = connected;
		if (connected || this.follow === "idle" || this.follow === "stopped")
			return;
		this.#forgetFollow();
		if (this.follow === "paused") return;
		this.follow = "disconnected";
		this.#announce("disconnected", 0);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation += 1;
		clearTimeout(this.#debounce);
		this.#detachFollow();
	}

	#apply(patch: Partial<RawFilter>): Promise<void> {
		const filter = { ...this.filter, ...patch };
		const refollow =
			(this.follow === "starting" || this.follow === "following") &&
			followBlock(filter, false) === null;
		this.#detachFollow();
		this.follow = "idle";
		this.ended = null;
		this.#checkpoint = null;
		this.filter = filter;
		return this.#load(refollow);
	}

	async #load(refollow: boolean, fence?: Fence): Promise<void> {
		const generation = ++this.#generation;
		const live = this.#detachFollow();
		const query = queryInput(this.filter, this.#deps.now());
		const edge: RawEdge = {
			query,
			continuation: null,
			hasMore: null,
			lost: false,
		};
		this.#list = [];
		this.#shownFrom = null;
		this.#heldDropped = 0;
		this.#openChain = true;
		this.capped = false;
		this.anchor = null;
		this.top = null;
		this.bottom = edge;
		this.failure = null;
		this.loading = "first";
		this.followBusy = true;
		const result = await this.#query(query);
		if (generation !== this.#generation) return;
		this.loading = null;
		if (result.ok) this.#place("bottom", edge, result);
		else {
			this.bottom = null;
			this.failure = { code: result.error, op: "first" };
		}
		await this.#continueFollow(live, refollow, fence);
	}

	/** After a head read, Follow continues from its resume position, or bootstrapping, the head it learned. */
	async #continueFollow(
		live: boolean,
		refollow: boolean,
		fence?: Fence,
	): Promise<void> {
		this.followBusy = false;
		if (fence !== undefined) {
			// A failed read proves nothing: the next Follow learns the head again.
			if (this.failure?.op === "first") {
				if (this.follow === "starting") this.follow = "idle";
				return;
			}
			this.#checkpoint ??= fence.head;
		}
		if (live && (this.follow === "following" || this.follow === "starting"))
			await this.#attach(
				fence?.announce ?? (this.follow === "starting" ? "following" : null),
			);
		else if (refollow) await this.startFollow();
	}

	#openAnchor(around: AroundPage): void {
		this.anchor = {
			cursor: around.anchor?.cursor ?? null,
			approximate: around.approximate,
		};
		this.top = {
			query: around.newerQuery,
			continuation: around.newer.continuation,
			hasMore: around.newer.hasMore,
			lost: false,
		};
		this.bottom = {
			query: around.olderQuery,
			continuation: around.older.continuation,
			hasMore: around.older.hasMore,
			lost: false,
		};
		const entries = [
			...[...around.newer.entries].reverse(),
			...(around.anchor === null ? [] : [around.anchor]),
			...around.older.entries,
		];
		this.#openChain = false;
		this.#write(placeRows([], entryRows(entries), "below"));
	}

	/** Newer pages arrive oldest first and go on top, older pages go below, and a head read's first page with entries replaces the list. */
	#place(end: RawEnd, edge: RawEdge, page: QueryPage): void {
		this[end] = {
			...edge,
			continuation: page.continuation,
			hasMore: page.hasMore,
		};
		const head = end === "bottom" && this.#openChain;
		const rows = entryRows(
			end === "top" ? [...page.entries].reverse() : page.entries,
		);
		const newest = newestCursor(rows);
		if (head && newest !== null) {
			// The page re-supplies what the caps cut; Follow resumes after it unless its newest entry was listed.
			if (!this.#list.some((row) => row.key === newest))
				this.#checkpoint = newest;
			this.#heldDropped = 0;
			this.capped = false;
		}
		if (newest !== null || page.hasMore === false) this.#openChain = false;
		this.#write(
			placeRows(
				this.#list,
				rows,
				end === "top" ? "above" : head ? "head" : "below",
			),
		);
	}

	/**
	 * The one writer of the list. While the list is read away from the top, rows
	 * that land above the first shown row wait as held entries.
	 */
	#write(next: RawRow[]): void {
		const from =
			this.#shownFrom ?? (this.#atTop ? null : (this.#list[0]?.key ?? null));
		const at = from === null ? 0 : this.#boundaryIn(next, from);
		const held = capRows(next.slice(0, at), HELD_CAP);
		// Held rows the cap cut: their skip counts join the overflow count, and a gap notice stays at the boundary.
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

	/** Where the first shown row sits in `next`; if a page replaced it, the next shown row it kept. */
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

	#query(input: LogQueryInput): Promise<LogQueryOutput> {
		return settle(
			() => this.#deps.logs.query(input),
			READ_FAILED,
			"System Logs raw query failed:",
		);
	}

	readonly #receive = (message: LogFollowMessage): void => {
		// Clear logs ends every follow on the device, so its notice counts even before a start reply names it.
		if (message.ended === "cleared") {
			this.#end("cleared");
			return;
		}
		if (this.#queued !== null) {
			this.#queued.push(message);
			return;
		}
		if (message.subscriptionId !== this.#subscription) return;
		this.#checkpoint = message.checkpointCursor ?? this.#checkpoint;
		const added = newRows(this.#list, followRows(message, ++this.#serial));
		this.#write(placeRows(this.#list, added, "above"));
		if (message.gap !== undefined || message.dropped > 0)
			this.#announce("gap", 0);
		else this.#announceNew(added.filter((row) => row.kind === "entry").length);
		if (message.ended !== undefined) this.#end(message.ended);
	};

	#end(reason: NonNullable<LogFollowMessage["ended"]>): void {
		this.#forgetFollow();
		this.follow = "stopped";
		this.ended = reason;
		this.#announce("stopped", 0);
		if (reason !== "cleared") return;
		this.#checkpoint = null;
		void this.reset();
	}

	/** Stops and forgets the device follow; true when it was running or starting. */
	#detachFollow(): boolean {
		const live = this.follow === "following" || this.follow === "starting";
		if (!live && this.#subscription === null) return false;
		if (this.#subscription !== null || this.follow === "starting")
			void this.#stop();
		this.#forgetFollow();
		return live;
	}

	/** Detaches this view from the device follow; late replies become stale. */
	#forgetFollow(): void {
		this.#followToken += 1;
		this.#subscription = null;
		this.#queued = null;
		this.followBusy = false;
		if (this.#ownsFollow()) this.#deps.setFollowListener(undefined);
	}

	/** No view has started a follow since this view's latest start. */
	#ownsFollow(): boolean {
		return followOwner === this.#owner;
	}

	/** Stops the socket's follow; a newer view's start already stopped this view's, so its own is left alone. */
	#stop(): Promise<LogFollowStopOutput | null> {
		return this.#ownsFollow()
			? settle(
					() => this.#deps.logs.followStop(),
					null,
					"System Logs follow stop failed:",
				)
			: Promise.resolve(null);
	}

	#announce(kind: RawAnnouncement["kind"], count: number): void {
		const serial = (this.announcement?.serial ?? 0) + 1;
		this.announcement = { kind, count, serial };
	}

	#announceNew(count: number): void {
		this.#pendingNew += count;
		const now = this.#deps.now();
		if (this.#pendingNew === 0 || now - this.#lastNewAt < NEW_ENTRIES_EVERY_MS)
			return;
		this.#lastNewAt = now;
		this.#announce("newEntries", this.#pendingNew);
		this.#pendingNew = 0;
	}
}

/** Drops every row, held entry and continuation and asks for the first page. */
export function resetRawView(view: RawView): Promise<void> {
	return view.reset();
}
