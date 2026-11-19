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
			}),
		);
	});
	media = installMediaQueries(() => inline);
	render(EventsTab, { onviewraw: onViewRaw });
	await screen.findAllByTestId("event-row");
	return retained;
}

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
		screen.getByRole("button", { name: error.startFromNewest }),
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
			survives ? raw : screen.getByRole("button", { name: copy.filter }),
		);

		const page = aroundPage();
		reply.resolve(page);
		await tick();
		expect(onViewRaw.mock.calls).toEqual(survives ? [[page]] : []);
	},
);

async function browseToOldest(): Promise<DeviceEvent[]> {
	const retained = await openHistory(401, false);
	for (const _page of [1, 2, 3]) await loadOlder();
	await screen.findByRole("button", { name: error.startFromNewest });
	return retained;
}

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
			survives ? raw : screen.getByRole("button", { name: copy.filter }),
		);
		expect(screen.getByRole("button", { name: copy.loadOlder })).toBeTruthy();
		const page = aroundPage();
		reply.resolve(page);
		await tick();
		expect(onViewRaw.mock.calls).toEqual(survives ? [[page]] : []);
	},
);

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
