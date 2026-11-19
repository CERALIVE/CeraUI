import type {
	LogAroundOutput,
	LogErrorCode,
	LogQueryInput,
	LogQueryOutput,
} from "@ceraui/rpc/schemas";
import type { RawFeedback } from "./raw-feedback.svelte";
import {
	levelCovering,
	queryInput,
	type RawFilter,
	type RawLevel,
} from "./raw-filter";
import type {
	FollowFence,
	RawFollowSession,
} from "./raw-follow-session.svelte";
import type { RawRowWindow } from "./raw-row-window.svelte";
import { entryRows, newestCursor } from "./raw-rows";
import { type RawViewDeps, READ_FAILED, settleRawRpc } from "./raw-view-rpc";

type QueryPage = Extract<LogQueryOutput, { ok: true }>;
export type AroundPage = Extract<LogAroundOutput, { ok: true }>;
export type RawEnd = "bottom" | "top";

export interface RawEdge {
	/** The query this end pages with: the tab's filter, or an anchor page's. */
	readonly query: LogQueryInput;
	readonly continuation: string | null;
	readonly hasMore: boolean | null;
	/** The device no longer stores this end's position. */
	readonly lost: boolean;
}

interface PagingContext {
	readonly rows: RawRowWindow;
	readonly feedback: RawFeedback;
	readonly follow: Pick<
		RawFollowSession,
		"detach" | "busy" | "afterHeadRead" | "setHeadPosition"
	>;
	filter(): RawFilter;
}

const EXPIRED: ReadonlySet<LogErrorCode> = new Set([
	"CURSOR_UNAVAILABLE",
	"FILTER_CHANGED",
]);

/** Each side of an exact anchor's entry that "Export this view" saves. */
const MOMENT_EXPORT_HALF_MS = 5 * 60_000;

/** Owns query generations, the fixed window's edges and head replay. */
export class RawPaging {
	loading = $state<"first" | RawEnd | null>(null);
	bottom = $state.raw<RawEdge | null>(null);
	/** Only in anchor mode, where the list pages toward newer entries too. */
	top = $state.raw<RawEdge | null>(null);
	anchor = $state.raw<{
		cursor: string | null;
		approximate: boolean;
		level: RawLevel;
	} | null>(null);
	#generation = 0;
	/** A head read's first page with entries replaces the list. */
	#openChain = false;

	constructor(
		private readonly deps: Pick<RawViewDeps, "logs" | "now" | "onQuery">,
		private readonly context: PagingContext,
	) {}

	invalidate(): void {
		this.#generation += 1;
	}

	/** Follow cannot run over an empty search with a position. Replay from the head next time. */
	prepareForFollow(): void {
		if (
			this.#openChain &&
			this.bottom !== null &&
			this.bottom.continuation !== null
		)
			this.bottom = { ...this.bottom, continuation: null, hasMore: null };
	}

	async loadHead(refollow: boolean, fence?: FollowFence): Promise<void> {
		const { rows, follow, feedback } = this.context;
		const generation = ++this.#generation;
		const live = follow.detach();
		const query = queryInput(this.context.filter(), this.deps.now());
		this.deps.onQuery?.(query);
		const edge: RawEdge = {
			query,
			continuation: null,
			hasMore: null,
			lost: false,
		};
		rows.clear();
		this.#openChain = true;
		this.anchor = null;
		this.top = null;
		this.bottom = edge;
		feedback.failure = null;
		this.loading = "first";
		follow.busy = true;
		const result = await this.#query(query);
		if (generation !== this.#generation) return;
		this.loading = null;
		if (result.ok) this.#place("bottom", edge, result);
		else {
			this.bottom = null;
			feedback.failure = { code: result.error, op: "first" };
		}
		await follow.afterHeadRead(live, refollow, fence);
	}

	async loadMore(end: RawEnd): Promise<void> {
		const { rows, follow, feedback } = this.context;
		const edge = this[end];
		if (
			edge === null ||
			edge.lost ||
			// A budget page with no position repeats this end's first query.
			(edge.continuation === null && edge.hasMore !== null) ||
			this.loading !== null ||
			(end === "bottom" && rows.capped)
		)
			return;
		// For a repeated head query, detach Follow until a page with entries is placed.
		const head = edge.continuation === null && this.anchor === null;
		const live = head && follow.detach();
		const generation = this.#generation;
		this.loading = end;
		feedback.failure = null;
		if (head) {
			follow.busy = true;
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
			feedback.failure = { code: result.error, op: end };
			if (EXPIRED.has(result.error)) this[end] = { ...edge, lost: true };
		}
		if (head) await follow.afterHeadRead(live, false);
	}

	openAnchor(around: AroundPage): void {
		// An approximate window's two edges cover its own bounded time window; an
		// exact anchor pages its whole boot, so its export keeps to its moment.
		if (around.anchor === null)
			this.deps.onQuery?.({
				...around.olderQuery,
				until: around.newerQuery.until,
			});
		else
			this.deps.onQuery?.(
				{
					...around.olderQuery,
					since: Math.max(0, around.anchor.ts - MOMENT_EXPORT_HALF_MS),
					until: around.anchor.ts + MOMENT_EXPORT_HALF_MS,
				},
				"moment",
			);
		this.anchor = {
			cursor: around.anchor?.cursor ?? null,
			approximate: around.approximate,
			level: levelCovering(around.olderQuery.levels),
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
		this.context.rows.showAnchor(entryRows(entries));
	}

	/** Positioned pages extend their own edge, but the first populated head page replaces the list. */
	#place(end: RawEnd, edge: RawEdge, page: QueryPage): void {
		const { rows, follow } = this.context;
		this[end] = {
			...edge,
			continuation: page.continuation,
			hasMore: page.hasMore,
		};
		const head = end === "bottom" && this.#openChain;
		const incoming = entryRows(
			end === "top" ? [...page.entries].reverse() : page.entries,
		);
		const newest = newestCursor(incoming);
		if (head && newest !== null) {
			// When the newest entry was already listed, keep the saved checkpoint.
			if (!rows.has(newest)) follow.setHeadPosition(newest);
			rows.reopen();
		}
		if (newest !== null || page.hasMore === false) this.#openChain = false;
		rows.place(incoming, end === "top" ? "above" : head ? "head" : "below");
	}

	#query(input: LogQueryInput): Promise<LogQueryOutput> {
		return settleRawRpc(
			() => this.deps.logs.query(input),
			READ_FAILED,
			"System Logs raw query failed:",
		);
	}
}
