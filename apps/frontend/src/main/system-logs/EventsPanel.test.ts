// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";

import Fake from "./__fixtures__/FakeEventsTab.svelte";
import EventsPanel from "./EventsPanel.svelte";

const load = vi.hoisted(() => vi.fn<() => Promise<{ default: unknown }>>());
vi.mock(
	"$lib/components/dialogs/lazy-dialog.svelte",
	async (
		importOriginal: () => Promise<
			typeof import("$lib/components/dialogs/lazy-dialog.svelte")
		>,
	) => {
		const actual = await importOriginal();
		return { ...actual, lazyDialog: () => actual.lazyDialog(load as never) };
	},
);

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	load.mockReset();
});

function has(element: Element | null | undefined, ...tokens: string[]): void {
	const classes = (element?.getAttribute("class") ?? "").split(/\s+/);
	for (const token of tokens) expect(classes, token).toContain(token);
}

describe("EventsPanel", () => {
	it("loads the Events tab as its own chunk on mount and hands it View raw logs", async () => {
		load.mockResolvedValueOnce({ default: Fake });
		const onviewraw = vi.fn();
		render(EventsPanel, { props: { onviewraw } });
		expect(load).toHaveBeenCalledTimes(1);

		await fireEvent.click(await screen.findByTestId("fake-events"));

		expect(onviewraw).toHaveBeenCalledExactlyOnceWith("around-page");
		expect(screen.queryByTestId("events-chunk-loading")).toBeNull();
	});

	it("shows loading rows only when the chunk is slow", async () => {
		vi.useFakeTimers();
		load.mockReturnValueOnce(new Promise(() => {}));
		render(EventsPanel, { props: { onviewraw: vi.fn() } });
		expect(screen.queryByTestId("events-chunk-loading")).toBeNull();

		await vi.advanceTimersByTimeAsync(150);

		const loading = screen.getByTestId("events-chunk-loading");
		expect(loading.getAttribute("role")).toBe("status");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		has(loading, "flex", "flex-col", "gap-3", "p-4");
		const skeletons = loading.querySelectorAll('[data-slot="skeleton"]');
		expect(skeletons).toHaveLength(3);
		has(skeletons[0], "h-8", "w-full");
		has(skeletons[1], "h-12", "w-full");
		has(skeletons[2], "h-12", "w-full");
		expect(
			within(loading).getByText(en.systemLogs.loading.events).className,
		).toContain("sr-only");
	});

	it("names a failed chunk and retries it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		load
			.mockRejectedValueOnce(new Error("chunk 404"))
			.mockResolvedValueOnce({ default: Fake });
		render(EventsPanel, { props: { onviewraw: vi.fn() } });

		const band = await screen.findByRole("alert");
		expect(band.dataset.testid).toBe("events-chunk-failed");
		has(
			band,
			"border-status-warning/30",
			"bg-status-warning/10",
			"m-4",
			"flex",
			"rounded-lg",
			"border",
			"p-3",
		);
		has(band.querySelector("svg"), "text-status-warning", "size-4", "shrink-0");
		const title = within(band).getByText(en.errorBoundary.title);
		has(title, "text-sm", "font-semibold");
		has(title.parentElement, "min-w-0", "flex-1", "space-y-1");
		has(within(band).getByText(en.errorBoundary.description), "text-sm");
		const retry = within(band).getByRole("button", {
			name: en.errorBoundary.retry,
		});
		has(retry, "shrink-0", "gap-1.5", "h-7", "border-border");
		has(retry.querySelector("svg"), "size-4");
		expect(screen.queryByTestId("events-chunk-loading")).toBeNull();
		expect(error).toHaveBeenCalled();

		await fireEvent.click(retry);

		expect(load).toHaveBeenCalledTimes(2);
		expect(await screen.findByTestId("fake-events")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
