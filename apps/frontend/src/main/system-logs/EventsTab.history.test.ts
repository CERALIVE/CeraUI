// @vitest-environment jsdom
import type {
	DeviceEvent,
	EventListInput,
	EventListOutput,
	LogAroundInput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

import {
	resetConnectionState,
	setConnectionState,
} from "$lib/components/custom/__fixtures__/connection-state.svelte";
import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import {
	aroundPage,
	EVENT_RING_EPOCH,
	event,
	eventPage,
} from "$lib/device-logs/__fixtures__/events";
import { notifyHistoryChanged } from "$lib/device-logs/history-bus";

import { en } from "../../tests/helpers/catalog";
import { installMediaQueries } from "../../tests/helpers/media-query";
import EventsTab from "./EventsTab.svelte";

type FeedListener = (events: DeviceEvent[]) => void;

const { list, around, feed } = vi.hoisted(() => ({
	list: vi.fn<(input: EventListInput) => Promise<EventListOutput>>(),
	around: vi.fn<(input: LogAroundInput) => Promise<LogAroundOutput>>(),
	feed: { listener: undefined as FeedListener | undefined },
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		events: { list },
		logs: { around, boots: () => Promise.resolve(fourBoots()) },
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setEventFeedListener: (listener: FeedListener | undefined) => {
		feed.listener = listener;
	},
}));

const { events: copy, action, error } = en.systemLogs;
const onViewRaw = vi.fn();
let media: ReturnType<typeof installMediaQueries> | undefined;

afterEach(() => {
	cleanup();
	resetConnectionState();
	media?.restore();
	list.mockReset();
	around.mockReset();
	onViewRaw.mockClear();
	vi.restoreAllMocks();
});

function stopped(seq: number): DeviceEvent {
	return event(seq, "stream_stopped", { cause: "operator", durationSec: 4 });
}

async function openHistory(
	count: number,
	inline = true,
	epoch?: string,
): Promise<DeviceEvent[]> {
	const retained = Array.from({ length: count }, (_, index) =>
		stopped(count - index),
	);
	list.mockImplementation(({ beforeSeq, limit }) => {
		const matches = retained.filter(
			(record) => beforeSeq === undefined || record.seq < beforeSeq,
		);
		const page = matches.slice(0, limit);
		return Promise.resolve(
			eventPage(page, {
				headSeq: retained[0]?.seq ?? 0,
				retainedFromSeq: 1,
				nextBeforeSeq:
					matches.length > page.length ? (page.at(-1)?.seq ?? null) : null,
				...(epoch === undefined ? {} : { epoch }),
			}),
		);
	});
	media = installMediaQueries(() => inline);
	render(EventsTab, { onviewraw: onViewRaw });
	await screen.findAllByTestId("event-row");
	return retained;
}

const newCount = (count: number) =>
	copy.startFromNewestCount.replace("{count}", String(count));
const lowerBound = (count: number) =>
	copy.startFromNewestAtLeast.replace("{count}", String(count));

function renderedTimes(): (string | null | undefined)[] {
	return screen
		.queryAllByTestId("event-row")
		.map((row) => row.querySelector("time")?.getAttribute("datetime"));
}

async function loadOlder(): Promise<void> {
	const button = screen.getByRole("button", { name: copy.loadOlder });
	button.focus();
	await fireEvent.click(button);
}

it("reaches the oldest of 401 matching events with a bounded window and stable paging focus", async () => {
	const retained = await openHistory(401);
	await loadOlder();
	await loadOlder();
	expect(renderedTimes()).toHaveLength(300);

	await loadOlder();
	expect(renderedTimes()).toEqual(
		retained.slice(100, 400).map((record) => new Date(record.at).toISOString()),
	);
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: copy.loadOlder }),
	);

	await loadOlder();
	expect(screen.getByText(copy.noOlder)).toBeTruthy();
	expect(renderedTimes()).toEqual(
		retained.slice(101).map((record) => new Date(record.at).toISOString()),
	);
	expect(document.activeElement?.closest('[data-testid="event-row"]')).toBe(
		screen.getAllByTestId("event-row").at(-1),
	);

	const newer = stopped(403);
	retained.unshift(newer, stopped(402));
	feed.listener?.([newer]);
	await tick();
	expect(renderedTimes().at(-1)).toBe(new Date(stopped(1).at).toISOString());
	expect(renderedTimes()[0]).toBe(new Date(stopped(300).at).toISOString());

	await fireEvent.click(
		await screen.findByRole("button", { name: lowerBound(2) }),
	);
	expect(renderedTimes()[0]).toBe(new Date(newer.at).toISOString());
});

it("retries an older page after pushes fill the display and revisits rows evicted by live traffic", async () => {
	const retained = await openHistory(350);
	vi.spyOn(console, "error").mockImplementation(() => {});
	list.mockRejectedValueOnce(new Error("down"));
	await loadOlder();
	const retry = screen.getByRole("button", { name: action.retry });
	expect(document.activeElement).toBe(retry);

	const pushed = Array.from({ length: 201 }, (_, index) =>
		stopped(351 + index),
	);
	retained.unshift(...pushed.toReversed());
	feed.listener?.(pushed);
	await tick();
	expect(renderedTimes()).toEqual(
		retained.slice(0, 300).map((record) => new Date(record.at).toISOString()),
	);

	await fireEvent.click(retry);

	expect(screen.queryByRole("alert")).toBeNull();
	expect(renderedTimes()).toEqual(
		retained.slice(100, 400).map((record) => new Date(record.at).toISOString()),
	);
});

it.each([
	{ outcome: "events", target: copy.viewRaw },
	{ outcome: "empty", target: copy.filter },
	{ outcome: "failure", target: action.retry },
	{ outcome: "events after the operator moves focus", target: copy.filter },
])(
	"hands off Start from newest focus on $outcome",
	async ({ outcome, target }) => {
		await openHistory(301, false);
		await loadOlder();
		await loadOlder();
		await loadOlder();
		const newest = screen.getByRole("button", { name: error.startFromNewest });
		const filter = screen.getByRole("button", { name: copy.filter });
		const reply = Promise.withResolvers<EventListOutput>();
		list.mockReturnValueOnce(reply.promise);
		newest.focus();

		await fireEvent.click(newest);
		if (outcome === "events after the operator moves focus") filter.focus();
		if (outcome === "failure") {
			vi.spyOn(console, "error").mockImplementation(() => {});
			reply.reject(new Error("down"));
		} else {
			reply.resolve(
				eventPage(outcome === "empty" ? [] : [stopped(302), stopped(301)]),
			);
		}
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: error.startFromNewest }),
			).toBeNull();
			expect(document.activeElement).toBe(
				screen.getAllByRole("button", { name: target })[0],
			);
		});
	},
);

it.each([
	{ reset: "a filter change", empty: copy.emptyFiltered },
	{ reset: "a history clear", empty: copy.emptyTitle },
])(
	"retires the focused raw action and restores a filter control after $reset",
	async ({ reset, empty }) => {
		await openHistory(1);
		const raw = screen.getByRole("button", { name: copy.viewRaw });
		raw.focus();
		list.mockResolvedValueOnce(eventPage([]));
		const filter = screen.getByRole("button", {
			name: en.timeline.family.stream,
		});

		if (reset === "a filter change") {
			await fireEvent.click(
				screen.getByRole("button", { name: en.timeline.family.network }),
			);
		} else {
			notifyHistoryChanged();
		}

		expect(await screen.findByText(empty)).toBeTruthy();
		expect(screen.queryByRole("button", { name: copy.viewRaw })).toBeNull();
		expect(document.activeElement).toBe(filter);
	},
);

it("does not open raw logs from a request started before history was cleared", async () => {
	await openHistory(1);
	const reply = Promise.withResolvers<LogAroundOutput>();
	around.mockReturnValueOnce(reply.promise);
	await fireEvent.click(screen.getByRole("button", { name: copy.viewRaw }));
	list.mockResolvedValueOnce(eventPage([]));

	notifyHistoryChanged();
	await screen.findByText(copy.emptyTitle);
	reply.resolve(aroundPage());
	await tick();

	expect(onViewRaw).not.toHaveBeenCalled();
});

it.each([
	{ outcome: "replaces the row", rows: [stopped(3)], survives: false },
	{ outcome: "fails", rows: null, survives: false },
	{ outcome: "keeps the row", rows: [stopped(3), stopped(1)], survives: true },
])(
	"settles focus and the pending raw action when a gap refresh $outcome",
	async ({ rows, survives }) => {
		await openHistory(1, false);
		const raw = screen.getByRole("button", { name: copy.viewRaw });
		const reply = Promise.withResolvers<LogAroundOutput>();
		around.mockReturnValueOnce(reply.promise);
		raw.focus();
		await fireEvent.click(raw);

		vi.spyOn(console, "error").mockImplementation(() => {});
		if (rows) list.mockResolvedValueOnce(eventPage(rows));
		else list.mockRejectedValueOnce(new Error("down"));
		feed.listener?.([stopped(3)]);

		const times = (rows ?? []).map(({ at }) => new Date(at).toISOString());
		await waitFor(() => expect(renderedTimes()).toEqual(times));
		expect(document.activeElement).toBe(
			survives
				? raw
				: rows
					? screen.getAllByRole("button", { name: copy.viewRaw })[0]
					: screen.getByRole("button", { name: copy.filter }),
		);

		const page = aroundPage();
		reply.resolve(page);
		await tick();
		expect(onViewRaw.mock.calls).toEqual(survives ? [[page]] : []);
	},
);

async function browseToOldest(epoch?: string): Promise<DeviceEvent[]> {
	const retained = await openHistory(401, false, epoch);
	for (const _page of [1, 2, 3]) await loadOlder();
	await screen.findByRole("button", { name: error.startFromNewest });
	return retained;
}

it("keeps focus and the row node when the same epoch returns after an omitted epoch", async () => {
	const retained = await openHistory(2, true, EVENT_RING_EPOCH);
	const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
	raw?.focus();

	const withoutEpoch = [stopped(4), stopped(3), ...retained];
	const omitted = eventPage(withoutEpoch, { epoch: undefined });
	list.mockResolvedValueOnce(omitted).mockResolvedValueOnce(omitted);
	feed.listener?.([stopped(4)]);
	await waitFor(() => expect(renderedTimes()).toEqual(times(withoutEpoch)));
	expect(document.activeElement).toBe(raw);

	const withEpoch = [stopped(6), stopped(5), ...withoutEpoch];
	const restored = eventPage(withEpoch);
	list.mockResolvedValueOnce(restored).mockResolvedValueOnce(restored);
	feed.listener?.([stopped(6)]);
	await waitFor(() => expect(renderedTimes()).toEqual(times(withEpoch)));

	expect(document.activeElement).toBe(raw);
	expect(screen.getAllByRole("button", { name: copy.viewRaw }).at(-1)).toBe(
		raw,
	);
	expect(raw?.getAttribute("tabindex")).toBe("0");
});

it("keeps focus and the row node when a gap refill reorders equivalent event params", async () => {
	await openHistory(2, true, EVENT_RING_EPOCH);
	const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
	raw?.focus();
	const reordered = event(1, "stream_stopped", {
		durationSec: 4,
		cause: "operator",
	});
	const refill = [stopped(4), stopped(3), stopped(2), reordered];
	list.mockResolvedValueOnce(eventPage(refill));

	feed.listener?.([stopped(4)]);
	await waitFor(() => expect(renderedTimes()).toEqual(times(refill)));

	expect(document.activeElement).toBe(raw);
	expect(screen.getAllByRole("button", { name: copy.viewRaw }).at(-1)).toBe(
		raw,
	);
	expect(raw?.getAttribute("tabindex")).toBe("0");
});

it("keeps the focused row mounted when a verified no-epoch older page extends the list", async () => {
	await openHistory(101);
	const row = screen.getAllByTestId("event-row")[1];
	const raw = row?.querySelector("button");
	raw?.focus();

	await fireEvent.click(screen.getByRole("button", { name: copy.loadOlder }));

	expect(screen.getAllByTestId("event-row")).toHaveLength(101);
	expect(screen.getAllByTestId("event-row")[1]).toBe(row);
	expect(document.activeElement).toBe(raw);
	expect(raw?.getAttribute("tabindex")).toBe("0");
});

it("moves the row stop off a replaced record whose seq and ID were reused", async () => {
	await browseToOldest();
	const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
	raw?.focus();
	const replacement = [stopped(210), { ...stopped(2), at: stopped(2).at + 1 }];
	list.mockResolvedValueOnce(
		eventPage(replacement, {
			epoch: undefined,
			headSeq: 210,
			retainedFromSeq: 1,
		}),
	);

	setConnectionState("disconnected");
	await screen.findByTestId("events-disconnected");
	setConnectionState("connected");

	await waitFor(() => expect(renderedTimes()).toEqual(times(replacement)));
	expect(raw?.isConnected).toBe(false);
	const first = screen.getAllByRole("button", { name: copy.viewRaw })[0];
	expect(document.activeElement).toBe(first);
	expect(first?.getAttribute("tabindex")).toBe("0");
});

it.each([
	{
		scenario: "the next push skips the missed event",
		pushed: [503],
		label: lowerBound(2),
	},
	{
		scenario: "the next push includes the delayed event",
		pushed: [502, 503],
		label: newCount(2),
	},
])(
	"keeps the unseen Events tally truthful when $scenario",
	async ({ pushed, label }) => {
		const retained = await openHistory(501, true, EVENT_RING_EPOCH);
		for (const _page of [1, 2, 3]) await loadOlder();
		const newest = screen.getByRole("button", { name: error.startFromNewest });

		// Seq 502 is stored, but the feed has not delivered it before the older read.
		retained.unshift(stopped(502));
		await loadOlder();
		const olderRows = retained
			.slice(201, 501)
			.map((record) => new Date(record.at).toISOString());
		expect(renderedTimes()).toEqual(olderRows);
		const pendingLabel = newest.textContent?.trim();

		retained.unshift(stopped(503));
		feed.listener?.(pushed.map(stopped));
		await waitFor(() => expect(newest.textContent?.trim()).toBe(label));
		expect(pendingLabel).toBe(copy.startFromNewestUnknown);
		expect(renderedTimes()).toEqual(olderRows);

		await loadOlder();
		expect(screen.getByText(copy.noOlder)).toBeTruthy();
		expect(renderedTimes().at(-1)).toBe(new Date(stopped(1).at).toISOString());
	},
);

it.each([
	{
		scenario: "a full page with more matches",
		size: 100,
		floor: 1,
		cursor: 452,
		head: 551,
	},
	{
		scenario: "an exactly full page",
		size: 100,
		floor: 402,
		cursor: null,
		head: 501,
	},
	{
		scenario: "a short filtered page after eviction",
		size: 3,
		floor: 420,
		cursor: null,
		head: 450,
	},
	{
		scenario: "an empty filtered page after eviction",
		size: 0,
		floor: 420,
		cursor: null,
		head: 450,
	},
])(
	"labels the new count truthfully for $scenario",
	async ({ size, floor, cursor, head }) => {
		await openHistory(401, true, EVENT_RING_EPOCH);
		await fireEvent.click(
			screen.getByRole("button", { name: en.timeline.family.stream }),
		);
		await waitFor(() => expect(renderedTimes()).toHaveLength(100));
		for (const _page of [1, 2, 3]) await loadOlder();
		const newest = screen.getByRole("button", { name: error.startFromNewest });
		list.mockResolvedValueOnce(
			eventPage(
				Array.from({ length: size }, (_, index) => stopped(head - index)),
				{
					headSeq: head,
					retainedFromSeq: floor,
					nextBeforeSeq: cursor,
				},
			),
		);

		setConnectionState("disconnected");
		await screen.findByTestId("events-disconnected");
		setConnectionState("connected");

		await waitFor(() =>
			expect(screen.queryByTestId("events-disconnected")).toBeNull(),
		);
		const label = size === 0 ? copy.startFromNewestUnknown : lowerBound(size);
		expect(newest.textContent?.trim()).toBe(label);

		feed.listener?.([stopped(head + 1)]);
		await tick();
		expect(newest.textContent?.trim()).toBe(lowerBound(size + 1));
	},
);

it("shows a lower bound after reconnect returns a full continued page with no additional matches", async () => {
	const retained = await openHistory(401, true, EVENT_RING_EPOCH);
	await fireEvent.click(
		screen.getByRole("button", { name: en.timeline.family.stream }),
	);
	for (const _page of [1, 2, 3]) await loadOlder();
	await screen.findByRole("button", { name: error.startFromNewest });
	feed.listener?.([stopped(402)]);
	const newest = await screen.findByRole("button", { name: newCount(1) });

	list.mockResolvedValueOnce(
		eventPage([stopped(402), ...retained.slice(0, 99)], {
			headSeq: 403,
			retainedFromSeq: 1,
			nextBeforeSeq: 303,
		}),
	);
	setConnectionState("disconnected");
	await screen.findByTestId("events-disconnected");
	setConnectionState("connected");
	await waitFor(() =>
		expect(screen.queryByTestId("events-disconnected")).toBeNull(),
	);

	expect(newest.textContent?.trim()).toBe(lowerBound(1));
	expect(screen.getByRole("button", { name: lowerBound(1) })).toBe(newest);
});

const times = (records: readonly DeviceEvent[]) =>
	records.map(({ at }) => new Date(at).toISOString());

it.each([
	{ outcome: "an unchanged window", floor: 1, survives: true },
	{ outcome: "a newer retained floor", floor: 101, survives: false },
])(
	"settles rows, focus and a pending raw action when a reconnect reports $outcome",
	async ({ floor, survives }) => {
		const retained = await browseToOldest();
		const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
		const reply = Promise.withResolvers<LogAroundOutput>();
		around.mockReturnValueOnce(reply.promise);
		raw?.focus();
		if (raw) await fireEvent.click(raw);
		list.mockResolvedValueOnce(
			eventPage(retained.slice(0, 100), {
				headSeq: 401,
				retainedFromSeq: floor,
				nextBeforeSeq: 302,
			}),
		);

		setConnectionState("disconnected");
		await screen.findByTestId("events-disconnected");
		setConnectionState("connected");

		await waitFor(() =>
			expect(screen.queryByTestId("events-disconnected")).toBeNull(),
		);
		expect(renderedTimes()).toEqual(
			times(retained.slice(100, survives ? 400 : 301)),
		);
		expect(document.activeElement).toBe(
			survives ? raw : screen.getAllByRole("button", { name: copy.viewRaw })[0],
		);
		expect(screen.getByRole("button", { name: copy.loadOlder })).toBeTruthy();
		const page = aroundPage();
		reply.resolve(page);
		await tick();
		expect(onViewRaw.mock.calls).toEqual(survives ? [[page]] : []);
	},
);

it("shows the empty list, retires a pending raw action and hands focus to the filter bar when a reconnect finds history cleared", async () => {
	await browseToOldest();
	const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
	const reply = Promise.withResolvers<LogAroundOutput>();
	around.mockReturnValueOnce(reply.promise);
	raw?.focus();
	if (raw) await fireEvent.click(raw);
	list.mockResolvedValueOnce(eventPage([], { headSeq: 0, retainedFromSeq: 0 }));

	setConnectionState("disconnected");
	await screen.findByTestId("events-disconnected");
	setConnectionState("connected");

	expect(await screen.findByText(copy.emptyTitle)).toBeTruthy();
	expect(renderedTimes()).toEqual([]);
	expect(screen.queryByRole("button", { name: copy.loadOlder })).toBeNull();
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: copy.filter }),
	);
	reply.resolve(aroundPage());
	await tick();
	expect(onViewRaw).not.toHaveBeenCalled();
});

it("shows the refilled ring, retires a pending raw action and hands focus to the first row when a reconnect names a new ring epoch", async () => {
	await browseToOldest("0f4c2a51-8d3e-4b7a-9c1f-2e6d8a4b5c7e");
	const raw = screen.getAllByRole("button", { name: copy.viewRaw }).at(-1);
	const reply = Promise.withResolvers<LogAroundOutput>();
	around.mockReturnValueOnce(reply.promise);
	raw?.focus();
	if (raw) await fireEvent.click(raw);
	// A clear and a restart refilled the ring past its old head, reusing every shown seq and id.
	const refilled = Array.from({ length: 450 }, (_, index) =>
		event(
			450 - index,
			"engine_lost",
			{ streaming: true },
			{
				at: Date.UTC(2026, 10, 17) + (450 - index) * 1000,
			},
		),
	);
	list.mockImplementation(({ limit }) =>
		Promise.resolve(
			eventPage(refilled.slice(0, limit), {
				headSeq: 450,
				retainedFromSeq: 1,
				nextBeforeSeq: 351,
				epoch: "6a1b9c3d-2e4f-4a5b-8c6d-7e8f9a0b1c2d",
			}),
		),
	);

	setConnectionState("disconnected");
	await screen.findByTestId("events-disconnected");
	setConnectionState("connected");

	await waitFor(() =>
		expect(renderedTimes()).toEqual(times(refilled.slice(0, 100))),
	);
	expect(
		screen.queryByRole("button", { name: error.startFromNewest }),
	).toBeNull();
	expect(document.activeElement).toBe(
		screen.getAllByRole("button", { name: copy.viewRaw })[0],
	);
	reply.resolve(aroundPage());
	await tick();
	expect(onViewRaw).not.toHaveBeenCalled();
});

it("names the new events on Start from newest while browsing, in place, until it returns to newest", async () => {
	const retained = await browseToOldest();
	const newest = screen.getByRole("button", { name: error.startFromNewest });
	// The counted label is long in some locales, so it wraps inside a 320 px bar.
	expect([...newest.classList]).toEqual(
		expect.arrayContaining([
			"h-auto",
			"max-w-full",
			"whitespace-normal",
			"text-balance",
		]),
	);
	const pushed = [stopped(403), stopped(402)];
	retained.unshift(...pushed);

	feed.listener?.([stopped(402)]);
	expect(await screen.findByRole("button", { name: newCount(1) })).toBe(newest);
	feed.listener?.([stopped(403)]);
	expect(await screen.findByRole("button", { name: newCount(2) })).toBe(newest);
	expect(renderedTimes()).toEqual(times(retained.slice(102, 402)));

	await fireEvent.click(newest);

	await waitFor(() =>
		expect(renderedTimes().slice(0, 2)).toEqual(times(pushed)),
	);
	expect(
		screen.queryByRole("button", { name: error.startFromNewest }),
	).toBeNull();
});

it("keeps the disconnected notice and a Retry until a reconnect check succeeds, then hands focus to the filter bar", async () => {
	const retained = await browseToOldest();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	setConnectionState("disconnected");
	await screen.findByTestId("events-disconnected");
	list.mockRejectedValueOnce(new Error("down"));

	setConnectionState("connected");

	const band = await screen.findByRole("alert");
	expect(band.textContent).toContain(copy.loadFailed);
	expect(screen.getByTestId("events-disconnected")).toBeTruthy();
	expect(renderedTimes()).toEqual(times(retained.slice(100, 400)));
	expect(errors).toHaveBeenCalledOnce();

	const retry = screen.getByRole("button", { name: action.retry });
	retry.focus();
	await fireEvent.click(retry);

	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	expect(screen.queryByTestId("events-disconnected")).toBeNull();
	expect(renderedTimes()).toEqual(times(retained.slice(100, 400)));
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: copy.filter }),
		),
	);
});
