import type { LogSource } from "@ceraui/rpc/schemas";
import { RawFeedback } from "./raw-feedback.svelte";
import {
	DEFAULT_RAW_FILTER,
	followBlock,
	type RawFilter,
	type RawLevel,
	type RawOrder,
	type RawTime,
	searchText,
} from "./raw-filter";
import { RawFollowSession } from "./raw-follow-session.svelte";
import { type AroundPage, type RawEnd, RawPaging } from "./raw-paging.svelte";
import { RawRowWindow } from "./raw-row-window.svelte";
import type { RawViewDeps } from "./raw-view-rpc";

export type { RawAnnouncement, RawFailure } from "./raw-feedback.svelte";
export type { FollowState } from "./raw-follow-session.svelte";
export type { AroundPage, RawEdge, RawEnd } from "./raw-paging.svelte";
export type { RawViewDeps } from "./raw-view-rpc";

const SEARCH_DEBOUNCE_MS = 300;

/** Operator actions and reactive state for one mounted Raw logs tab. */
export class RawView {
	filter = $state.raw<RawFilter>(DEFAULT_RAW_FILTER);
	draft = $state("");
	readonly #rows = new RawRowWindow();
	readonly #feedback: RawFeedback;
	readonly #follow: RawFollowSession;
	readonly #pages: RawPaging;
	#disposed = false;
	#debounce: ReturnType<typeof setTimeout> | undefined;

	followBlocked = $derived(followBlock(this.filter, this.anchor !== null));
	newestFirst = $derived(
		this.anchor !== null || this.filter.order === "newest",
	);
	/** Nothing shown may look fresh: the socket is down or cut the follow. */
	stale = $derived(!this.connected || this.follow === "disconnected");

	constructor(deps: RawViewDeps) {
		this.#feedback = new RawFeedback(deps);
		this.#follow = new RawFollowSession(deps, {
			rows: this.#rows,
			feedback: this.#feedback,
			filter: () => this.filter,
			canFollow: () => this.followBlocked === null,
			isDisposed: () => this.#disposed,
			preparePagingForFollow: () => this.#pages.prepareForFollow(),
			readHead: (fence) => this.#pages.loadHead(false, fence),
		});
		this.#pages = new RawPaging(deps, {
			rows: this.#rows,
			feedback: this.#feedback,
			follow: this.#follow,
			filter: () => this.filter,
		});
	}

	get rows() {
		return this.#rows.rows;
	}

	get held() {
		return this.#rows.held;
	}

	get capped() {
		return this.#rows.capped;
	}

	get loading() {
		return this.#pages.loading;
	}

	get bottom() {
		return this.#pages.bottom;
	}

	get top() {
		return this.#pages.top;
	}

	get anchor() {
		return this.#pages.anchor;
	}

	get failure() {
		return this.#feedback.failure;
	}

	get announcement() {
		return this.#feedback.announcement;
	}

	get follow() {
		return this.#follow.state;
	}

	get ended() {
		return this.#follow.ended;
	}

	get followBusy() {
		return this.#follow.busy;
	}

	get connected() {
		return this.#follow.connected;
	}

	/** Runs the first query, or opens anchor mode on a `logs.around` result. */
	start(anchor?: AroundPage): Promise<void> {
		if (anchor === undefined) return this.reset();
		this.#pages.openAnchor(anchor);
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
		return this.#pages.loadHead(false);
	}

	loadMore(end: RawEnd): Promise<void> {
		return this.#pages.loadMore(end);
	}

	get loadingGap(): string | null {
		return this.#pages.loadingGap;
	}

	loadGap(
		key: string,
		continuation: string,
	): Promise<string | null | undefined> {
		return this.#pages.loadGap(key, continuation);
	}

	retry(): Promise<void> {
		const op = this.failure?.op;
		if (op === "first") return this.reset();
		if (op === "follow") return this.startFollow();
		return op === undefined ? Promise.resolve() : this.loadMore(op);
	}

	startFollow(): Promise<void> {
		return this.#follow.start();
	}

	pauseFollow(): Promise<void> {
		return this.#follow.pause();
	}

	setAtTop(atTop: boolean): void {
		this.#rows.setAtTop(atTop);
	}

	showHeld(): void {
		this.#rows.showHeld();
	}

	connectionChanged(state: string): void {
		this.#follow.connectionChanged(state);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#pages.invalidate();
		clearTimeout(this.#debounce);
		this.#follow.detach();
	}

	#apply(patch: Partial<RawFilter>): Promise<void> {
		const filter = { ...this.filter, ...patch };
		const live = this.#follow.resetForFilter();
		this.filter = filter;
		return this.#pages.loadHead(live && followBlock(filter, false) === null);
	}
}

/** Drops every row, held entry and continuation and asks for the first page. */
export function resetRawView(view: RawView): Promise<void> {
	return view.reset();
}
