// @vitest-environment jsdom
import type {
	DeviceEvent,
	EventListInput,
	EventListOutput,
} from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { event, eventPage } from "$lib/device-logs/__fixtures__/events";

import { en } from "../../tests/helpers/catalog";
import { installMediaQueries } from "../../tests/helpers/media-query";
import EventsTab from "./EventsTab.svelte";

type FeedListener = (events: DeviceEvent[]) => void;

const { list, feed } = vi.hoisted(() => ({
	list: vi.fn<(input: EventListInput) => Promise<EventListOutput>>(),
	feed: { listener: undefined as FeedListener | undefined },
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: { events: { list }, logs: { boots: async () => fourBoots() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
	setEventFeedListener: (listener: FeedListener | undefined) => {
		feed.listener = listener;
	},
}));

const { events: copy, action, error } = en.systemLogs;
let media: ReturnType<typeof installMediaQueries> | undefined;

afterEach(() => {
	cleanup();
	media?.restore();
	list.mockReset();
	vi.restoreAllMocks();
});

function stopped(seq: number): DeviceEvent {
	return event(seq, "stream_stopped", { cause: "operator", durationSec: 4 });
}

async function openHistory(count: number): Promise<DeviceEvent[]> {
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
	media = installMediaQueries(() => true);
	render(EventsTab, { onviewraw: vi.fn() });
	await screen.findAllByTestId("event-row");
	return retained;
}

function renderedTimes(): (string | null | undefined)[] {
	return screen
		.getAllByTestId("event-row")
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
