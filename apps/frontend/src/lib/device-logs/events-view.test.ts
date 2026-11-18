import type {
	DeviceEvent,
	EventListInput,
	EventListOutput,
	LogAroundInput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOT_IDS } from "./__fixtures__/boots";
import { aroundPage, EVENT_AT, event, eventPage } from "./__fixtures__/events";
import { EventsView } from "./events-view.svelte";

type Feed = (events: DeviceEvent[]) => void;

afterEach(() => {
	vi.restoreAllMocks();
});

function setup(bootId: string | null = null) {
	const list = vi.fn<(input: EventListInput) => Promise<EventListOutput>>();
	const around = vi.fn<(input: LogAroundInput) => Promise<LogAroundOutput>>();
	let feed: Feed | undefined;
	const setFeedListener = vi.fn((listener: Feed | undefined) => {
		feed = listener;
	});
	const view = new EventsView({ list, around, setFeedListener }, bootId);
	const push = (...events: DeviceEvent[]) => feed?.(events);
	return { view, list, around, setFeedListener, push };
}

function quietErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {});
}

const ids = (view: EventsView) => view.events.map((item) => item.seq);
const e = (seq: number, extra: Partial<DeviceEvent> = {}) =>
	event(seq, "internet_lost", {}, extra);

describe("EventsView — the first page", () => {
	it("reads the newest page with only a limit when nothing is filtered", async () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([e(3), e(2), e(1)]));

		await view.reload();

		expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
		expect(ids(view)).toEqual([3, 2, 1]);
		expect(view.loading).toBeNull();
		expect(view.failed).toBeNull();
		expect(view.nextBeforeSeq).toBeNull();
	});

	it("starts on the boot chosen in the boot picker", async () => {
		const { view, list } = setup(BOOT_IDS.clean);
		list.mockResolvedValue(eventPage([]));

		await view.reload();

		expect(list).toHaveBeenCalledExactlyOnceWith({
			limit: 100,
			bootId: BOOT_IDS.clean,
		});
		expect(view.filter).toEqual({
			families: [],
			problemsOnly: false,
			bootId: BOOT_IDS.clean,
		});
	});

	it("is loading, with no rows, until the page arrives", async () => {
		const { view, list } = setup();
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValue(reply.promise);

		const read = view.reload();
		expect(view.loading).toBe("first");
		expect(view.events).toEqual([]);

		reply.resolve(eventPage([e(1)], { nextBeforeSeq: 1 }));
		await read;
		expect(view.loading).toBeNull();
		expect(view.nextBeforeSeq).toBe(1);
	});

	it("states a failed read and keeps no rows from before it", async () => {
		const { view, list } = setup();
		const errors = quietErrors();
		list.mockResolvedValueOnce(eventPage([e(1)], { nextBeforeSeq: 1 }));
		await view.reload();
		const failure = new Error("Request timeout: events.list");
		list.mockRejectedValueOnce(failure);

		await view.reload();

		expect(view.failed).toBe("first");
		expect(view.events).toEqual([]);
		expect(view.nextBeforeSeq).toBeNull();
		expect(view.loading).toBeNull();
		expect(errors).toHaveBeenCalledOnce();
		expect(errors).toHaveBeenCalledWith(expect.stringMatching(/\S/), failure);
	});

	it("turns a client that throws at once into a failed read", async () => {
		const { view, list } = setup();
		quietErrors();
		list.mockImplementation(() => {
			throw new TypeError(
				"Cannot read properties of undefined (reading 'list')",
			);
		});

		await view.reload();

		expect(view.failed).toBe("first");
	});

	it("clears the failure when it reads again", async () => {
		const { view, list } = setup();
		quietErrors();
		list.mockRejectedValueOnce(new Error("down"));
		await view.reload();
		list.mockResolvedValueOnce(eventPage([e(4)]));

		await view.reload();

		expect(view.failed).toBeNull();
		expect(ids(view)).toEqual([4]);
	});

	it("lets only the newest read settle", async () => {
		const { view, list } = setup();
		const errors = quietErrors();
		const slow = Promise.withResolvers<EventListOutput>();
		const slowFailure = Promise.withResolvers<EventListOutput>();
		list
			.mockReturnValueOnce(slow.promise)
			.mockReturnValueOnce(slowFailure.promise)
			.mockResolvedValueOnce(eventPage([e(9)]));

		const first = view.reload();
		const second = view.reload();
		const third = view.reload();
		await third;
		slow.resolve(eventPage([e(1)], { nextBeforeSeq: 1 }));
		slowFailure.reject(new Error("late"));
		await Promise.all([first, second]);

		expect(ids(view)).toEqual([9]);
		expect(view.nextBeforeSeq).toBeNull();
		expect(view.failed).toBeNull();
		expect(view.loading).toBeNull();
		expect(errors).not.toHaveBeenCalled();
	});
});

describe("EventsView — filters", () => {
	it("sends one family per selected chip and drops a chip when it is selected again", async () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([]));

		view.toggleFamily("stream");
		view.toggleFamily("network");
		view.toggleFamily("stream");
		view.toggleFamily("network");
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));

		expect(list.mock.calls.map(([input]) => input)).toEqual([
			{ limit: 100, families: ["stream"] },
			{ limit: 100, families: ["stream", "network"] },
			{ limit: 100, families: ["network"] },
			{ limit: 100 },
		]);
	});

	it("sends problemsOnly only while Problems only is on", () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([]));

		view.setProblemsOnly(true);
		view.setProblemsOnly(false);

		expect(list.mock.calls.map(([input]) => input)).toEqual([
			{ limit: 100, problemsOnly: true },
			{ limit: 100 },
		]);
	});

	it("reads the chosen boot, and choosing the same boot again reads nothing", () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([]));

		view.setBoot(BOOT_IDS.unclean);
		view.setBoot(BOOT_IDS.unclean);
		view.setBoot(null);
		view.setBoot(null);

		expect(list.mock.calls.map(([input]) => input)).toEqual([
			{ limit: 100, bootId: BOOT_IDS.unclean },
			{ limit: 100 },
		]);
	});

	it("Show all events clears every filter in one read", () => {
		const { view, list } = setup(BOOT_IDS.clean);
		list.mockResolvedValue(eventPage([]));
		view.toggleFamily("update");
		view.setProblemsOnly(true);
		list.mockClear();

		view.showAll();

		expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
		expect(view.filter).toEqual({
			families: [],
			problemsOnly: false,
			bootId: null,
		});
	});

	it("reports whether anything narrows the list", () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([]));
		expect(view.filtered).toBe(false);
		view.toggleFamily("device");
		expect(view.filtered).toBe(true);
		view.toggleFamily("device");
		view.setProblemsOnly(true);
		expect(view.filtered).toBe(true);
		view.setProblemsOnly(false);
		view.setBoot(BOOT_IDS.clean);
		expect(view.filtered).toBe(true);
		view.setBoot(null);
		expect(view.filtered).toBe(false);
	});

	it("drops the rows and the next page of the previous filter at once", async () => {
		const { view, list } = setup();
		list.mockResolvedValueOnce(eventPage([e(2), e(1)], { nextBeforeSeq: 1 }));
		await view.reload();
		list.mockReturnValueOnce(new Promise(() => {}));

		view.setProblemsOnly(true);

		expect(view.events).toEqual([]);
		expect(view.nextBeforeSeq).toBeNull();
		expect(view.loading).toBe("first");
	});
});

describe("EventsView — Load older", () => {
	it("pages with beforeSeq and the same filter, appending without repeats", async () => {
		const { view, list } = setup();
		list.mockResolvedValueOnce(
			eventPage([e(5, { severity: "error" }), e(4, { severity: "error" })], {
				nextBeforeSeq: 4,
			}),
		);
		view.setProblemsOnly(true);
		await vi.waitFor(() => expect(view.loading).toBeNull());
		const older = Promise.withResolvers<EventListOutput>();
		list.mockReturnValueOnce(older.promise);

		const read = view.loadOlder();
		expect(view.loading).toBe("older");
		older.resolve(
			eventPage([e(4, { severity: "error" }), e(2, { severity: "error" })], {
				nextBeforeSeq: null,
				headSeq: 5,
			}),
		);
		await read;

		expect(list).toHaveBeenLastCalledWith({
			limit: 100,
			beforeSeq: 4,
			problemsOnly: true,
		});
		expect(ids(view)).toEqual([5, 4, 2]);
		expect(view.nextBeforeSeq).toBeNull();
		expect(view.loading).toBeNull();
	});

	it("does nothing at the end of the history or while a page is being read", async () => {
		const { view, list } = setup();
		list.mockResolvedValueOnce(eventPage([e(1)]));
		await view.reload();
		await expect(view.loadOlder()).resolves.toBeUndefined();
		expect(list).toHaveBeenCalledTimes(1);

		list.mockResolvedValueOnce(eventPage([e(3)], { nextBeforeSeq: 3 }));
		await view.reload();
		list.mockReturnValueOnce(new Promise(() => {}));
		void view.loadOlder();
		await expect(view.loadOlder()).resolves.toBeUndefined();
		expect(list).toHaveBeenCalledTimes(3);
		expect(list).toHaveBeenLastCalledWith({ limit: 100, beforeSeq: 3 });
	});

	it("keeps the rows shown when an older page fails, and can retry it", async () => {
		const { view, list } = setup();
		quietErrors();
		list.mockResolvedValueOnce(eventPage([e(3)], { nextBeforeSeq: 3 }));
		await view.reload();
		list.mockRejectedValueOnce(new Error("down"));

		await view.loadOlder();
		expect(view.failed).toBe("older");
		expect(ids(view)).toEqual([3]);
		expect(view.nextBeforeSeq).toBe(3);

		list.mockResolvedValueOnce(eventPage([e(2)]));
		await view.loadOlder();
		expect(view.failed).toBeNull();
		expect(ids(view)).toEqual([3, 2]);
	});

	it("drops an older page that arrives after the list was read again", async () => {
		const { view, list } = setup();
		list.mockResolvedValueOnce(eventPage([e(3)], { nextBeforeSeq: 3 }));
		await view.reload();
		const older = Promise.withResolvers<EventListOutput>();
		list
			.mockReturnValueOnce(older.promise)
			.mockResolvedValueOnce(eventPage([e(8)]));

		const read = view.loadOlder();
		await view.reload();
		older.resolve(eventPage([e(1)], { nextBeforeSeq: 1 }));
		await read;

		expect(ids(view)).toEqual([8]);
		expect(view.nextBeforeSeq).toBeNull();
	});
});

describe("EventsView — pushed events", () => {
	async function ready(
		events: DeviceEvent[],
		extra: Partial<EventListOutput> = {},
	) {
		const harness = setup();
		harness.list.mockResolvedValueOnce(eventPage(events, extra));
		await harness.view.reload();
		return harness;
	}

	it("puts a new event first and orders by seq, never by time", async () => {
		const { view, push } = await ready([e(2), e(1)]);

		push(e(3, { at: EVENT_AT - 60_000 }));

		expect(ids(view)).toEqual([3, 2, 1]);
	});

	it("never shows an event already in the list twice", async () => {
		const { view, push, list } = await ready([e(2), e(1)]);

		push(e(3), e(3));
		push(e(2));

		expect(ids(view)).toEqual([3, 2, 1]);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("reads the list again instead of guessing when events were missed", async () => {
		const { view, push, list } = await ready([e(3)]);
		list.mockResolvedValueOnce(eventPage([e(5), e(4), e(3)]));

		push(e(5));
		await vi.waitFor(() => expect(view.loading).toBeNull());

		expect(list).toHaveBeenCalledTimes(2);
		expect(ids(view)).toEqual([5, 4, 3]);
	});

	it("keeps the shown rows through a gap re-read until its first page replaces them", async () => {
		const { view, push, list } = await ready([e(2), e(1)], { headSeq: 2 });
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValueOnce(reply.promise);
		const shown = view.events;

		push(e(5));
		expect(view.loading).toBe("first");
		expect(view.events).toBe(shown);

		reply.resolve(eventPage([e(5), e(4)], { nextBeforeSeq: 4 }));
		await vi.waitFor(() => expect(view.loading).toBeNull());
		expect(ids(view)).toEqual([5, 4]);
		expect(view.nextBeforeSeq).toBe(4);
	});

	it("keeps no rows from before a gap re-read that fails", async () => {
		const { view, push, list } = await ready([e(2), e(1)], {
			headSeq: 2,
			nextBeforeSeq: 1,
		});
		quietErrors();
		list.mockRejectedValueOnce(new Error("down"));

		push(e(5));
		await vi.waitFor(() => expect(view.loading).toBeNull());

		expect(view.failed).toBe("first");
		expect(view.events).toEqual([]);
		expect(view.nextBeforeSeq).toBeNull();
	});

	it("checks for a gap on every event of a batch", async () => {
		const { push, list } = await ready([e(3)]);
		list.mockReturnValue(new Promise(() => {}));

		push(e(4), e(6));

		expect(list).toHaveBeenCalledTimes(2);
	});

	it("measures gaps from the device's head, not from the rows a filter shows", async () => {
		const { view, push, list } = await ready([], { headSeq: 10 });

		push(e(11));

		expect(list).toHaveBeenCalledTimes(1);
		expect(ids(view)).toEqual([11]);
	});

	it("keeps a push the first page was read too early to include", async () => {
		const { view, push, list } = setup();
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValue(reply.promise);
		const read = view.reload();

		push(e(7));
		reply.resolve(eventPage([e(6)]));
		await read;

		expect(ids(view)).toEqual([7, 6]);
	});

	it("neither shows nor re-reads for the next push while the first page is being read", async () => {
		const { view, push, list } = setup();
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValue(reply.promise);
		const read = view.reload();

		push(e(1));
		expect(view.events).toEqual([]);
		reply.resolve(eventPage([e(6)]));
		await read;

		expect(ids(view)).toEqual([6]);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("re-reads when a push held through the first page skips past that page", async () => {
		const { view, push, list } = setup();
		const reply = Promise.withResolvers<EventListOutput>();
		list
			.mockReturnValueOnce(reply.promise)
			.mockReturnValueOnce(new Promise(() => {}));
		const read = view.reload();

		push(e(8));
		reply.resolve(eventPage([e(6)]));
		await read;

		expect(list).toHaveBeenCalledTimes(2);
		expect(view.loading).toBe("first");
	});

	it("re-reads an empty history when the first push is not seq 1", async () => {
		const { view, push, list } = await ready([], { headSeq: 0 });
		list.mockReturnValueOnce(new Promise(() => {}));

		push(e(2));

		expect(list).toHaveBeenCalledTimes(2);
		expect(view.loading).toBe("first");
	});

	it("admits seq 1 as the first push to an empty history", async () => {
		const { view, push, list } = await ready([], { headSeq: 0 });

		push(e(1));

		expect(list).toHaveBeenCalledTimes(1);
		expect(ids(view)).toEqual([1]);
	});

	it("ignores pushes after a failed first page", async () => {
		const { view, push, list } = setup();
		quietErrors();
		list.mockRejectedValueOnce(new Error("down"));
		await view.reload();

		push(e(1));

		expect(view.events).toEqual([]);
	});

	it("shows only pushed events the filter admits, and still counts the rest", async () => {
		const harness = setup(BOOT_IDS.current);
		harness.list.mockResolvedValue(eventPage([], { headSeq: 1 }));
		harness.view.toggleFamily("network");
		harness.view.setProblemsOnly(true);
		await vi.waitFor(() => expect(harness.view.loading).toBeNull());
		harness.list.mockClear();

		harness.push(
			e(2, { family: "network", severity: "info" }),
			e(3, { family: "stream", severity: "error" }),
			e(4, { family: "network", severity: "error", bootId: BOOT_IDS.clean }),
			e(5, { family: "network", severity: "warning" }),
			e(6, { family: "network", severity: "error" }),
		);

		expect(ids(harness.view)).toEqual([6, 5]);
		expect(harness.list).not.toHaveBeenCalled();
	});
});

describe("EventsView — connection", () => {
	it("marks the list stale while disconnected and reads it again on reconnect", async () => {
		const { view, list } = setup();
		list.mockResolvedValue(eventPage([e(1)]));
		await view.reload();

		view.connectionChanged("disconnected");
		expect(view.stale).toBe(true);
		view.connectionChanged("connecting");
		expect(view.stale).toBe(true);
		expect(list).toHaveBeenCalledTimes(1);

		view.connectionChanged("connected");
		expect(view.stale).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("does not read again when it was never disconnected", () => {
		const { view, list } = setup();
		view.connectionChanged("connected");
		expect(view.stale).toBe(false);
		expect(list).not.toHaveBeenCalled();
	});
});

describe("EventsView — View raw logs", () => {
	it("asks for the raw entries around the event and opens them", async () => {
		const { view, around } = setup();
		const page = aroundPage(true);
		const reply = Promise.withResolvers<LogAroundOutput>();
		around.mockReturnValue(reply.promise);
		const open = vi.fn();
		const target = e(4, { bootId: BOOT_IDS.clean, at: EVENT_AT + 7 });

		const opening = view.viewRaw(target, open);
		expect(view.rawLink).toEqual({ id: target.id, state: "pending" });
		reply.resolve(page);
		await opening;

		expect(around).toHaveBeenCalledExactlyOnceWith({
			bootId: BOOT_IDS.clean,
			at: EVENT_AT + 7,
			eventId: target.id,
		});
		expect(open).toHaveBeenCalledExactlyOnceWith(page);
		expect(view.rawLink).toBeNull();
	});

	it.each([
		["BOOT_UNAVAILABLE", "removed"],
		["BUSY", "busy"],
		["READ_FAILED", "failed"],
		["JOURNAL_UNAVAILABLE", "failed"],
	] as const)("states %s on the row", async (error, state) => {
		const { view, around } = setup();
		around.mockResolvedValue({ ok: false, error });
		const open = vi.fn();

		await view.viewRaw(e(2), open);

		expect(view.rawLink).toEqual({ id: e(2).id, state });
		expect(open).not.toHaveBeenCalled();
	});

	it("states a failed request on the row", async () => {
		const { view, around } = setup();
		const errors = quietErrors();
		const failure = new Error("Request timeout: logs.around");
		around.mockRejectedValue(failure);

		await view.viewRaw(e(2), vi.fn());

		expect(view.rawLink).toEqual({ id: e(2).id, state: "failed" });
		expect(errors).toHaveBeenCalledOnce();
		expect(errors).toHaveBeenCalledWith(expect.stringMatching(/\S/), failure);
	});

	it("contains a consumer that throws while opening the raw logs", async () => {
		const { view, around } = setup();
		const errors = quietErrors();
		around.mockResolvedValue(aroundPage());

		await view.viewRaw(e(2), () => {
			throw new Error("tab switch failed");
		});

		expect(view.rawLink).toEqual({ id: e(2).id, state: "failed" });
		expect(errors).toHaveBeenCalledOnce();
	});

	it("follows only the newest request", async () => {
		const { view, around } = setup();
		const errors = quietErrors();
		const first = Promise.withResolvers<LogAroundOutput>();
		const second = Promise.withResolvers<LogAroundOutput>();
		around
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const open = vi.fn();

		const a = view.viewRaw(e(1), open);
		const b = view.viewRaw(e(2), open);
		second.resolve({ ok: false, error: "BOOT_UNAVAILABLE" });
		await b;
		first.resolve(aroundPage());
		await a;

		expect(open).not.toHaveBeenCalled();
		expect(view.rawLink).toEqual({ id: e(2).id, state: "removed" });

		const late = Promise.withResolvers<LogAroundOutput>();
		around
			.mockReturnValueOnce(late.promise)
			.mockResolvedValueOnce(aroundPage());
		const c = view.viewRaw(e(3), open);
		await view.viewRaw(e(4), open);
		late.reject(new Error("late"));
		await c;
		expect(open).toHaveBeenCalledOnce();
		expect(view.rawLink).toBeNull();
		expect(errors).not.toHaveBeenCalled();
	});
});

describe("EventsView — lifetime", () => {
	it("listens for pushed events from construction until it is disposed", () => {
		const { view, setFeedListener } = setup();
		expect(setFeedListener).toHaveBeenCalledOnce();
		expect(setFeedListener.mock.calls[0]?.[0]).toBeTypeOf("function");

		view.dispose();

		expect(setFeedListener).toHaveBeenLastCalledWith(undefined);
	});

	it("stops listening exactly once however often it is disposed", () => {
		const { view, setFeedListener } = setup();

		view.dispose();
		view.dispose();

		expect(setFeedListener.mock.calls).toEqual([
			[expect.any(Function)],
			[undefined],
		]);
	});

	it("starts no read and opens nothing for replies that arrive after it is disposed", async () => {
		const { view, push, list, around } = setup();
		const first = Promise.withResolvers<EventListOutput>();
		const second = Promise.withResolvers<EventListOutput>();
		const raw = Promise.withResolvers<LogAroundOutput>();
		list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		around.mockReturnValue(raw.promise);
		const open = vi.fn();
		const reads = [view.reload(), view.reload()];
		push(e(9));
		const opening = view.viewRaw(e(1), open);

		view.dispose();
		first.resolve(eventPage([e(1)]));
		second.resolve(eventPage([e(1)]));
		raw.resolve(aroundPage());
		await Promise.all([...reads, opening]);

		expect(list).toHaveBeenCalledTimes(2);
		expect(view.events).toEqual([]);
		expect(open).not.toHaveBeenCalled();
	});
});
