/**
 * The Events tab's state: the event history, newest first and always in `seq`
 * order (never by time), its filters and paging, and the events the device
 * pushes while the tab is open. A push that skips a `seq` re-reads the list
 * instead of guessing what was missed; a disconnect marks the list stale and
 * the reconnect re-reads it. Only the newest read may settle, and a push that
 * arrives while the first page is read joins that page unless the page already
 * covers it. Disposing drops every reply still in flight and stops listening
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

function merge(
	shown: readonly DeviceEvent[],
	more: readonly DeviceEvent[],
): DeviceEvent[] {
	const ids = new Set(shown.map((event) => event.id));
	const merged = [...shown];
	for (const event of more) {
		if (ids.has(event.id)) continue;
		ids.add(event.id);
		merged.push(event);
	}
	return merged.sort((a, b) => b.seq - a.seq);
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
	stale = $state(false);
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
	#held: DeviceEvent[] = [];
	#disposed = false;
	#rawRequest: object | undefined;

	constructor(deps: EventsViewDeps, bootId: string | null) {
		this.#deps = deps;
		this.filter = { ...this.filter, bootId };
		deps.setFeedListener((events) => this.#receive(events));
	}

	/** The first page again, from the newest event, dropping every row shown. */
	reload(): Promise<void> {
		this.#generation += 1;
		this.events = [];
		this.nextBeforeSeq = null;
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

	connectionChanged(state: ConnectionState): void {
		if (state !== "connected") {
			this.stale = true;
		} else if (this.stale) {
			this.stale = false;
			void this.reload();
		}
	}

	/** Asks for the raw entries around `event`; only the newest request may open them. */
	async viewRaw(
		event: DeviceEvent,
		open: (page: AroundPage) => void,
	): Promise<void> {
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

	async #read(end: End): Promise<void> {
		const generation = this.#generation;
		this.loading = end;
		this.failed = null;
		let newer: DeviceEvent[] = [];
		try {
			const page = await this.#deps.list(
				listInput(this.filter, end === "older" ? this.nextBeforeSeq : null),
			);
			if (generation !== this.#generation) return;
			this.#head = Math.max(this.#head, page.headSeq);
			this.events = merge(this.events, page.events);
			this.nextBeforeSeq = page.nextBeforeSeq;
			newer = this.#held.splice(0).filter((event) => event.seq > page.headSeq);
		} catch (error) {
			if (generation !== this.#generation) return;
			console.error("System Logs could not read the event history:", error);
			this.failed = end;
		}
		this.loading = null;
		this.#receive(newer);
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
		for (const event of batch) {
			if (event.seq > this.#head + 1) {
				void this.reload();
				return;
			}
			this.#head = Math.max(this.#head, event.seq);
			if (admits(this.filter, event)) admitted.push(event);
		}
		this.events = merge(this.events, admitted);
	}
}
