// @vitest-environment jsdom
import type {
	EventListOutput,
	LogAroundOutput,
	LogBootInfo,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import {
	aroundPage,
	event,
	eventPage,
} from "$lib/device-logs/__fixtures__/events";
import { bootSelection } from "$lib/device-logs/boot-selection.svelte";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import SystemLogsView from "./SystemLogsView.svelte";

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: vi.fn<() => Promise<unknown>>(),
		boots: vi.fn<() => Promise<LogBootInfo[]>>(),
		around: vi.fn<() => Promise<LogAroundOutput>>(),
		query: vi.fn(),
	},
	events: { list: vi.fn<() => Promise<EventListOutput>>() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setEventFeedListener: vi.fn(),
	setLogFollowListener: vi.fn(),
}));

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;

beforeEach(() => {
	media = installMediaQueries((query) => query === WIDE);
	rpc.logs.getStorage.mockReset();
	rpc.logs.getStorage.mockResolvedValue({});
	rpc.logs.boots.mockReset();
	rpc.logs.boots.mockResolvedValue(fourBoots());
	rpc.logs.around.mockReset();
	rpc.logs.query.mockReset();
	rpc.logs.query.mockResolvedValue(aroundPage().older);
	rpc.events.list.mockReset();
	rpc.events.list.mockResolvedValue(
		eventPage([event(1, "device_started", {}, { severity: "info" })]),
	);
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	bootSelection.reset();
});

function tab(name: string): HTMLElement {
	return screen.getByRole("tab", { name });
}

describe("SystemLogsView — Events panel", () => {
	it("opens on the Events tab showing the device's event history", async () => {
		render(SystemLogsView);

		const panel = await screen.findByTestId("system-logs-panel-events");
		const title = await within(panel).findByText(
			en.timeline.device_started.title,
		);
		expect(title.closest('[data-testid="event-row"]')).toBeTruthy();
		expect(rpc.events.list).toHaveBeenCalledWith({ limit: 100 });
	});

	it("switches to the Raw logs tab when an event's View raw logs finds its entries", async () => {
		rpc.logs.around.mockResolvedValue(aroundPage());
		render(SystemLogsView);
		const panel = await screen.findByTestId("system-logs-panel-events");
		const action = await within(panel).findByRole("button", {
			name: en.systemLogs.events.viewRaw,
		});

		await fireEvent.click(action);

		await waitFor(() =>
			expect(tab(en.systemLogs.tabs.raw).getAttribute("aria-selected")).toBe(
				"true",
			),
		);
		expect(
			screen.getByTestId("system-logs-panel-events").childElementCount,
		).toBe(0);
		expect(await screen.findByTestId("raw-anchor-empty")).toBeTruthy();
		expect(rpc.logs.around).toHaveBeenCalledTimes(1);
		expect(rpc.logs.query).not.toHaveBeenCalled();
	});
});
