// The Events window is ordered by sequence. Reconnect and gap reads preserve
// history only when their list still identifies the same ring.
import type {
	DeviceEvent,
	EventFamily,
	EventListInput,
	EventListOutput,
	LogAroundInput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";

import type { ConnectionState } from "$lib/rpc/client";

import { admits, type EventFilter, listInput } from "./events-filter";
import { type AroundPage, EventsRawLink } from "./events-raw-link.svelte";
import { EVENT_ROW_CAP, mergeEvents } from "./events-window";

export type { AroundPage, RawLinkState } from "./events-raw-link.svelte";

export interface EventsViewDeps {
	readonly list: (input: EventListInput) => Promise<EventListOutput>;
	readonly around: (input: LogAroundInput) => Promise<LogAroundOutput>;
	readonly setFeedListener: (
		listener: ((events: DeviceEvent[]) => void) | undefined,
	) => void;
}

type End = "first" | "older";

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
	get rawLink() {
		return this.#raw.link;
	}
	readonly filtered = $derived(
		this.filter.families.length > 0 ||
			this.filter.problemsOnly ||
			this.filter.bootId !== null,
	);
	readonly #deps: EventsViewDeps;
	readonly #raw = new EventsRawLink();
	#generation = 0;
	#head = 0;
	#retainedFrom = 0;
	#epoch: string | undefined;
	#held: DeviceEvent[] = [];
	#connected: boolean | undefined;
	#disposed = false;

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
		this.#raw.reset();
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
			this.#held = [];
			this.stale = true;
			this.liveEdgeFailed = false;
		} else if (this.stale) {
			if (this.browsingHistory) void this.checkLiveEdge();
			else void this.reload();
		}
	}

	/** Asks for the raw entries around `event`; only the newest request may open them. */
	viewRaw(event: DeviceEvent, open: (page: AroundPage) => void): Promise<void> {
		return this.#raw.open(event, this.#deps.around, open);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation += 1;
		this.#raw.reset();
		this.#deps.setFeedListener(undefined);
	}

	#setFilter(filter: EventFilter): void {
		this.filter = filter;
		void this.reload();
	}

	async #read(
		end: End,
		mode: "replace" | "gap" | "live-edge" = "replace",
	): Promise<void> {
		const generation = end === "first" ? ++this.#generation : this.#generation;
		// The queue belongs to one connection. A superseded read cannot drain a new queue.
		const held = this.#held;
		const current = () =>
			generation === this.#generation && held === this.#held;
		const beforeSeq = end === "older" ? this.nextBeforeSeq : null;
		const startingRows = this.events;
		this.loading = end;
		// An older page's failure stays while it is read again, so its Retry keeps focus.
		if (end === "first" && mode !== "live-edge") this.failed = null;
		let newer: DeviceEvent[] = [];
		let settleRows = mode === "gap";
		try {
			const page = await this.#deps.list(listInput(this.filter, beforeSeq));
			if (!current()) return;
			const seen = this.#head;
			const sameEpoch = page.epoch !== undefined && page.epoch === this.#epoch;
			this.#epoch = page.epoch;
			// A lower edge already replaces the whole window without a second list.
			const lowerEdge =
				mode === "live-edge" && page.epoch === undefined && page.headSeq < seen;
			if (!sameEpoch && !lowerEdge && (end === "older" || mode !== "replace")) {
				void this.reload();
				return;
			}
			// A first page reports the head at its read; pushes since then are held.
			this.#head =
				end === "first" ? page.headSeq : Math.max(seen, page.headSeq);
			this.#retainedFrom = page.retainedFromSeq;
			if (mode === "live-edge") {
				// Seq only grows while the ring is kept, so a lower head proves a clear,
				// after which seq, and so a shown row's id, can repeat.
				if (page.headSeq < seen) {
					this.events = page.events;
					this.nextBeforeSeq = page.nextBeforeSeq;
					this.newWhileBrowsing = 0;
					this.#raw.reset();
					settleRows = true;
				} else {
					const kept = this.events.filter(
						(event) =>
							event.seq >= page.retainedFromSeq && event.seq <= page.headSeq,
					);
					// shortcut: counts at most one page of unseen events, so a gap or outage
					// longer than PAGE undercounts; page toward the head if that becomes routine.
					this.newWhileBrowsing += page.events.filter(
						(event) => event.seq > seen,
					).length;
					settleRows = kept.length < this.events.length;
					if (settleRows) this.events = kept;
				}
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
			newer = held.splice(0).filter((event) => event.seq > page.headSeq);
		} catch (error) {
			if (!current()) return;
			console.error("System Logs could not read the event history:", error);
			if (mode === "live-edge") {
				// Offline, the next reconnect checks again, so Retry waits for the link.
				this.liveEdgeFailed = this.#connected === true;
			} else {
				if (end === "first") {
					this.events = [];
					this.nextBeforeSeq = null;
				}
				this.failed = end;
			}
		} finally {
			if (generation === this.#generation) {
				if (mode === "live-edge") held.length = 0;
				this.loading = null;
			}
		}
		if (!current()) return;
		this.#receive(newer);
		if (settleRows) {
			const link = this.rawLink;
			if (
				link?.state === "pending" &&
				!this.events.some(({ id }) => id === link.id)
			)
				this.#raw.reset();
			this.rowReset = { keepShownFocus: true };
		}
	}

	// A push while the first page is being read waits for that page: the device
	// may have sent it after taking the page, so it joins unless its seq is at or
	// below the page's headSeq, which the page already covers.
	#receive(batch: readonly DeviceEvent[]): void {
		if (this.#connected === false) return;
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
