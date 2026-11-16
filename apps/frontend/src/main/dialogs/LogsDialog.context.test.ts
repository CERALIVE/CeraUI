// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fourBoots } from "$lib/device-logs/__fixtures__/boots";
import { eventPage } from "$lib/device-logs/__fixtures__/events";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import LogsDialog from "./LogsDialog.svelte";

const rpc = vi.hoisted(() => ({
	logs: {
		getStorage: () => Promise.resolve({}),
		boots: vi.fn(),
		around: vi.fn(),
		query: vi.fn(),
	},
	events: { list: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: vi.fn(),
	setEventFeedListener: vi.fn(),
}));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({ isStreaming: false, isFullyStale: false }),
}));

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;

function viewport(wide: boolean): void {
	media = installMediaQueries((query) => query === WIDE && wide);
}

function selected(): string | undefined {
	return screen
		.getAllByRole("tab")
		.find((node) => node.getAttribute("aria-selected") === "true")
		?.textContent?.trim();
}

beforeEach(() => {
	vi.clearAllMocks();
	rpc.logs.boots.mockReset().mockResolvedValue(fourBoots());
	rpc.logs.around
		.mockReset()
		.mockResolvedValue({ ok: false, error: "READ_FAILED" });
	rpc.logs.query
		.mockReset()
		.mockResolvedValue({ ok: false, error: "READ_FAILED" });
	rpc.events.list.mockResolvedValue(eventPage([]));
	viewport(true);
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
});

describe("LogsDialog — opened with a deep-link context", () => {
	it.each(["events", "storage"] as const)(
		"leaves a %s context on that view without reading raw logs",
		async (tab) => {
			media?.restore();
			viewport(false);
			render(LogsDialog, {
				props: {
					open: true,
					context: {
						tab,
						at: 1_800_000_000_000,
						bootId: "66d8d1808694489b8c3a3fb4795cab24",
					},
				},
			});
			await screen.findByRole("tablist");
			expect(
				screen
					.getByRole("tab", { name: en.systemLogs.tabs[tab] })
					.getAttribute("aria-selected"),
			).toBe("true");
			await screen.findByTestId("boot-button");
			if (tab === "events") await screen.findByTestId("events-empty");
			expect(rpc.logs.boots).toHaveBeenCalledTimes(tab === "events" ? 2 : 1);
			expect(rpc.logs.around).not.toHaveBeenCalled();
			expect(rpc.logs.query).not.toHaveBeenCalled();
		},
	);

	it("does not issue around after closing while boots is still loading", async () => {
		const boots = Promise.withResolvers<unknown>();
		rpc.logs.boots.mockReturnValue(boots.promise);
		const view = render(LogsDialog, {
			props: { open: true, context: { tab: "raw", at: 1_800_000_000_000 } },
		});
		await waitFor(() => expect(rpc.logs.boots).toHaveBeenCalledTimes(2));
		view.unmount();
		boots.resolve([
			{
				bootId: "66d8d1808694489b8c3a3fb4795cab24",
				index: 0,
				current: true,
				shutdown: "current",
				firstTs: 1_799_000_000_000,
				lastTs: 1_800_000_000_000,
				evidence: [],
				logsAvailable: true,
				versions: null,
			},
		]);
		await boots.promise;
		await tick();
		expect(rpc.logs.around).not.toHaveBeenCalled();
	});

	it("opens on Events when no context is given", async () => {
		render(LogsDialog, { props: { open: true } });

		await screen.findByRole("tablist");
		expect(selected()).toBe(en.systemLogs.tabs.events);
	});

	it("opens on Raw logs for a View logs request", async () => {
		render(LogsDialog, {
			props: { open: true, context: { tab: "raw", at: 1_700_000_000_000 } },
		});

		await screen.findByRole("tablist");
		expect(selected()).toBe(en.systemLogs.tabs.raw);
		expect(screen.getByTestId("system-logs-panel-raw").hidden).toBe(false);
	});

	it("opens on the Storage tab below 1024 px for the low-disk banner", async () => {
		media?.restore();
		viewport(false);
		render(LogsDialog, { props: { open: true, context: { tab: "storage" } } });

		await screen.findByRole("tablist");
		expect(selected()).toBe(en.systemLogs.tabs.storage);
		const panel = screen.getByTestId("system-logs-panel-storage");
		expect(within(panel).getByTestId("system-logs-storage")).toBeTruthy();
	});

	it("keeps Storage in view at 1024 px and up, where it is the side column", async () => {
		render(LogsDialog, { props: { open: true, context: { tab: "storage" } } });

		await screen.findByRole("tablist");
		expect(selected()).toBe(en.systemLogs.tabs.events);
		expect(
			within(screen.getByTestId("system-logs-side")).getByTestId(
				"system-logs-storage",
			),
		).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(screen.getByTestId("system-logs-storage")).getByRole("heading", {
					name: en.systemLogs.storage.heading,
				}),
			),
		);
	});

	it("follows a new request while open, after the operator moved elsewhere", async () => {
		const view = render(LogsDialog, {
			props: { open: true, context: { tab: "raw", at: 1 } },
		});
		await screen.findByRole("tablist");
		await fireEvent.click(
			screen.getByRole("tab", { name: en.systemLogs.tabs.events }),
		);
		expect(selected()).toBe(en.systemLogs.tabs.events);

		await view.rerender({ open: true, context: { tab: "raw", at: 2 } });

		expect(selected()).toBe(en.systemLogs.tabs.raw);
	});
});
