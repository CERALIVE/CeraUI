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

import Fake from "./__fixtures__/FakeRawLogsTab.svelte";
import RawLogsPanel from "./RawLogsPanel.svelte";

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

describe("RawLogsPanel", () => {
	it("loads the Raw logs tab as its own chunk on mount", async () => {
		load.mockResolvedValueOnce({ default: Fake });
		render(RawLogsPanel);
		expect(load).toHaveBeenCalledTimes(1);
		expect(await screen.findByTestId("fake-raw-logs")).toBeTruthy();
		expect(screen.queryByTestId("raw-logs-chunk-loading")).toBeNull();
	});

	it("shows loading rows only when the chunk is slow", async () => {
		vi.useFakeTimers();
		load.mockReturnValueOnce(new Promise(() => {}));
		render(RawLogsPanel);
		expect(screen.queryByTestId("raw-logs-chunk-loading")).toBeNull();
		await vi.advanceTimersByTimeAsync(150);
		const loading = screen.getByTestId("raw-logs-chunk-loading");
		expect(loading.getAttribute("role")).toBe("status");
		expect(loading.getAttribute("aria-busy")).toBe("true");
		has(loading, "flex", "flex-col", "gap-3", "p-4");
		const skeletons = loading.querySelectorAll('[data-slot="skeleton"]');
		expect(skeletons).toHaveLength(3);
		has(skeletons[0], "h-8", "w-full");
		has(skeletons[1], "h-12", "w-full");
		has(skeletons[2], "h-12", "w-full");
		expect(
			within(loading).getByText(en.systemLogs.loading.entries).className,
		).toContain("sr-only");
		expect(
			loading.querySelectorAll('[data-slot="skeleton"]').length,
		).toBeGreaterThan(0);
	});

	it("names a failed chunk and retries it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		load
			.mockRejectedValueOnce(new Error("chunk 404"))
			.mockResolvedValueOnce({ default: Fake });
		render(RawLogsPanel);
		const band = await screen.findByRole("alert");
		expect(band.dataset.testid).toBe("raw-logs-chunk-failed");
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
		expect(within(band).getByText(en.errorBoundary.title)).toBeTruthy();
		expect(within(band).getByText(en.errorBoundary.description)).toBeTruthy();
		expect(screen.queryByTestId("raw-logs-chunk-loading")).toBeNull();
		expect(error).toHaveBeenCalled();
		await fireEvent.click(
			within(band).getByRole("button", { name: en.errorBoundary.retry }),
		);
		expect(load).toHaveBeenCalledTimes(2);
		expect(await screen.findByTestId("fake-raw-logs")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
