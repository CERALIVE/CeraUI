/**
 * The Events tab's state: the event history, newest first and always in `seq`
 * order (never by time), its filters and paging, and the events the device
 * pushes while the tab is open. A push that skips a `seq` re-reads the list
 * instead of guessing what was missed, keeping the rows shown until the first
 * page replaces them; a disconnect marks the list stale and
 * the reconnect re-reads it. While browsing older events, the reconnect instead
 * checks the live edge: the list stays stale until a check succeeds, and that
 * check removes only rows below the new retention floor, keeping the window,
 * its paging and every other row's action. Pushes leave a browsed window in
 * place and only count the new events Start from newest will show; a skipped
 * `seq` reads the live edge for that count. Only the newest read may settle,
 * and a push that arrives while the first page is read joins that page unless
 * the page already covers it. Disposing drops every reply still in flight and stops listening
 * once; disposing again does nothing. Data loads only in these methods, never in
 * an effect.
 */
import type {
	DeviceEvent,
	EventFamily,
	EventListInput,
	EventListOutput,
	LogAroundInput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";

import type { ConnectionState } from "$lib/rpc/client";

import { EVENT_ROW_CAP, mergeEvents } from "./events-window";

export type AroundPage = Extract<LogAroundOutput, { ok: true }>;
export type RawLinkState = "pending" | "removed" | "busy" | "failed";

export interface EventsViewDeps {
	readonly list: (input: EventListInput) => Promise<EventListOutput>;
	readonly around: (input: LogAroundInput) => Promise<LogAroundOutput>;
	readonly setFeedListener: (
		listener: ((events: DeviceEvent[]) => void) | undefined,
	) => void;
}

export interface EventFilter {
	readonly families: readonly EventFamily[];
	readonly problemsOnly: boolean;
	readonly bootId: string | null;
}

type End = "first" | "older";

const PAGE = 100;
const PROBLEMS = new Set(["error", "warning"]);

function listInput(
	filter: EventFilter,
	beforeSeq: number | null,
): EventListInput {
	return {
		limit: PAGE,
		...(beforeSeq === null ? {} : { beforeSeq }),
		...(filter.families.length === 0 ? {} : { families: [...filter.families] }),
		...(filter.problemsOnly ? { problemsOnly: true } : {}),
		...(filter.bootId === null ? {} : { bootId: filter.bootId }),
	};
}

function admits(filter: EventFilter, event: DeviceEvent): boolean {
	return (
		(filter.families.length === 0 || filter.families.includes(event.family)) &&
		(!filter.problemsOnly || PROBLEMS.has(event.severity)) &&
		(filter.bootId === null || filter.bootId === event.bootId)
	);
}

export class EventsView {
	events = $state.raw<readonly DeviceEvent[]>([]);
	filter = $state.raw<EventFilter>({
		families: [],
		problemsOnly: false,
		bootId: null,
	});
	loading = $state<End | null>(null);
	failed = $state<End | null>(null);
	nextBeforeSeq = $state<number | null>(null);
	browsingHistory = $state(false);
	rowReset = $state.raw<{ readonly keepShownFocus: boolean }>({
		keepShownFocus: false,
	});
	stale = $state(false);
	liveEdgeFailed = $state(false);
	newWhileBrowsing = $state(0);
	rawLink = $state.raw<{
		readonly id: string;
		readonly state: RawLinkState;
	} | null>(null);
	readonly filtered = $derived(
		this.filter.families.length > 0 ||
			this.filter.problemsOnly ||
			this.filter.bootId !== null,
	);
	readonly #deps: EventsViewDeps;
	#generation = 0;
	#head = 0;
	#retainedFrom = 0;
	#held: DeviceEvent[] = [];
	#connected = false;
	#disposed = false;
	#rawRequest: object | undefined;

	constructor(deps: EventsViewDeps, bootId: string | null) {
		this.#deps = deps;
		this.filter = { ...this.filter, bootId };
		deps.setFeedListener((events) => this.#receive(events));
	}

	/** The first page again, from the newest event, dropping every row shown. */
	reload(): Promise<void> {
		// Every row shown is dropped, so once connected nothing stale remains.
		if (this.#connected) this.stale = false;
		this.liveEdgeFailed = false;
		this.newWhileBrowsing = 0;
		this.rowReset = { keepShownFocus: false };
		this.#clearRawLink();
		this.events = [];
		this.nextBeforeSeq = null;
		this.browsingHistory = false;
		return this.#read("first");
	}

	loadOlder(): Promise<void> {
		if (this.loading !== null || this.nextBeforeSeq === null)
			return Promise.resolve();
		return this.#read("older");
	}

	toggleFamily(family: EventFamily): void {
		const { families } = this.filter;
		this.#setFilter({
			...this.filter,
			families: families.includes(family)
				? families.filter((chosen) => chosen !== family)
				: [...families, family],
		});
	}

	setProblemsOnly(problemsOnly: boolean): void {
		this.#setFilter({ ...this.filter, problemsOnly });
	}

	setBoot(bootId: string | null): void {
		if (bootId !== this.filter.bootId)
			this.#setFilter({ ...this.filter, bootId });
	}

	showAll(): void {
		this.#setFilter({ families: [], problemsOnly: false, bootId: null });
	}

	/** Reads the newest page again for its retention floor, keeping the browsed window. */
	checkLiveEdge(): Promise<void> {
		return this.#read("first", "live-edge");
	}

	connectionChanged(state: ConnectionState): void {
		this.#connected = state === "connected";
		if (!this.#connected) {
			this.stale = true;
			this.liveEdgeFailed = false;
		} else if (this.stale) {
			if (this.browsingHistory) void this.checkLiveEdge();
			else void this.reload();
		}
	}

	/** Asks for the raw entries around `event`; only the newest request may open them. */
	async viewRaw(
		event: DeviceEvent,
		open: (page: AroundPage) => void,
	): Promise<void> {
		// The pending action stays focusable (aria-disabled), so a repeat press lands here.
		if (this.rawLink?.id === event.id && this.rawLink.state === "pending")
			return;
		const request = {};
		this.#rawRequest = request;
		this.rawLink = { id: event.id, state: "pending" };
		let state: RawLinkState;
		try {
			const result = await this.#deps.around({
				bootId: event.bootId,
				at: event.at,
				eventId: event.id,
			});
			if (request !== this.#rawRequest) return;
			if (result.ok) {
				this.rawLink = null;
				open(result);
				return;
			}
			state =
				result.error === "BOOT_UNAVAILABLE"
					? "removed"
					: result.error === "BUSY"
						? "busy"
						: "failed";
		} catch (error) {
			if (request !== this.#rawRequest) return;
			console.error(
				"System Logs could not open the raw logs of an event:",
				error,
			);
			state = "failed";
		}
		this.rawLink = { id: event.id, state };
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation += 1;
		this.#rawRequest = undefined;
		this.#deps.setFeedListener(undefined);
	}

	#setFilter(filter: EventFilter): void {
		this.filter = filter;
		void this.reload();
	}

	#clearRawLink(): void {
		this.#rawRequest = undefined;
		this.rawLink = null;
	}

	async #read(
		end: End,
		mode: "replace" | "gap" | "live-edge" = "replace",
	): Promise<void> {
		const generation = end === "first" ? ++this.#generation : this.#generation;
		const beforeSeq = end === "older" ? this.nextBeforeSeq : null;
		const startingRows = this.events;
		this.loading = end;
		// An older page's failure stays while it is read again, so its Retry keeps focus.
		if (end === "first" && mode !== "live-edge") this.failed = null;
		let newer: DeviceEvent[] = [];
		let settleRows = mode === "gap";
		try {
			const page = await this.#deps.list(listInput(this.filter, beforeSeq));
			if (generation !== this.#generation) return;
			const seen = this.#head;
			this.#head = Math.max(this.#head, page.headSeq);
			this.#retainedFrom = page.retainedFromSeq;
			if (mode === "live-edge") {
				// shortcut: counts at most one page of unseen events, so a gap or outage
				// longer than PAGE undercounts; page toward the head if that becomes routine.
				this.newWhileBrowsing += page.events.filter(
					(event) => event.seq > seen,
				).length;
				const kept = this.events.filter(
					(event) => event.seq >= this.#retainedFrom,
				);
				settleRows = kept.length < this.events.length;
				if (settleRows) this.events = kept;
				this.stale = false;
				this.liveEdgeFailed = false;
			} else {
				this.failed = null;
				// If pushes passed the request's edge, join the reply to its original
				// window. Joining to the live window would leave a hole between them.
				const liveEdgeMoved =
					end === "older" && beforeSeq !== this.nextBeforeSeq;
				const shown = liveEdgeMoved ? startingRows : this.events;
				const merged = mergeEvents(
					end === "first"
						? []
						: shown.filter((event) => event.seq >= this.#retainedFrom),
					page.events,
				);
				if (liveEdgeMoved || merged.length > EVENT_ROW_CAP)
					this.browsingHistory = true;
				this.events = merged.slice(-EVENT_ROW_CAP);
				this.nextBeforeSeq = page.nextBeforeSeq;
			}
			newer = this.#held.splice(0).filter((event) => event.seq > page.headSeq);
		} catch (error) {
			if (generation !== this.#generation) return;
			console.error("System Logs could not read the event history:", error);
			if (mode === "live-edge") {
				// Offline, the next reconnect checks again, so Retry waits for the link.
				this.liveEdgeFailed = this.#connected;
			} else {
				if (end === "first") {
					this.events = [];
					this.nextBeforeSeq = null;
				}
				this.failed = end;
			}
		} finally {
			if (generation === this.#generation) {
				if (mode === "live-edge") this.#held.length = 0;
				this.loading = null;
			}
		}
		if (generation !== this.#generation) return;
		this.#receive(newer);
		if (settleRows) {
			const link = this.rawLink;
			if (
				link?.state === "pending" &&
				!this.events.some(({ id }) => id === link.id)
			)
				this.#clearRawLink();
			this.rowReset = { keepShownFocus: true };
		}
	}

	// A push while the first page is being read waits for that page: the device
	// may have sent it after taking the page, so it joins unless its seq is at or
	// below the page's headSeq, which the page already covers.
	#receive(batch: readonly DeviceEvent[]): void {
		if (this.loading === "first") {
			this.#held.push(...batch);
			return;
		}
		if (this.failed === "first") return;
		const admitted: DeviceEvent[] = [];
		let fresh = 0;
		for (const event of batch) {
			if (event.seq > this.#head + 1) {
				// While browsing, only the count needs what was missed, not the rows.
				if (this.browsingHistory) this.newWhileBrowsing += fresh;
				void this.#read("first", this.browsingHistory ? "live-edge" : "gap");
				return;
			}
			if (event.seq >= this.#retainedFrom && admits(this.filter, event)) {
				admitted.push(event);
				if (event.seq > this.#head) fresh += 1;
			}
			this.#head = Math.max(this.#head, event.seq);
		}
		// A browsed window stays in place; Start from newest names what arrived.
		if (this.browsingHistory) {
			this.newWhileBrowsing += fresh;
			return;
		}
		if (admitted.length === 0) return;
		const merged = mergeEvents(this.events, admitted);
		this.events = merged.slice(0, EVENT_ROW_CAP);
		// The live edge can evict rows the last server cursor has already passed.
		if (merged.length > EVENT_ROW_CAP)
			this.nextBeforeSeq = this.events.at(-1)?.seq ?? null;
	}
}
