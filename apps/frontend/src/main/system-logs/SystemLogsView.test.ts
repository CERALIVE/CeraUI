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

import { RpcError } from "$lib/rpc/rpc-error";

import { en } from "../../tests/helpers/catalog";
import {
	installMediaQueries,
	type MediaQueryControl,
} from "../../tests/helpers/media-query";

import { logStorage, MIB } from "./__fixtures__/log-storage";
import SystemLogsView from "./SystemLogsView.svelte";

const rpc = vi.hoisted(
	() =>
		({}) as {
			logs?: {
				getStorage: () => Promise<unknown>;
				deleteOlderFiles?: () => Promise<unknown>;
				query: () => Promise<unknown>;
			};
		},
);
const getDeviceLog = vi.hoisted(() => vi.fn());
const getSystemLog = vi.hoisted(() => vi.fn());
const ensureNamespaces = vi.hoisted(() =>
	vi.fn<(namespaces: readonly string[]) => Promise<void>>(),
);

vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/rpc/subscriptions.svelte", async () => ({
	...(await import(
		"$lib/components/custom/__fixtures__/connection-state.svelte"
	)),
	setLogFollowListener: vi.fn(),
}));
vi.mock("$lib/helpers/SystemHelper", () => ({ getDeviceLog, getSystemLog }));
vi.mock(
	"@ceraui/i18n/svelte",
	async (
		importOriginal: () => Promise<typeof import("@ceraui/i18n/svelte")>,
	) => ({
		...(await importOriginal()),
		ensureNamespaces,
	}),
);

const WIDE = "(min-width: 1024px)";
let media: MediaQueryControl | undefined;
const getStorage = vi.fn<() => Promise<unknown>>();

function viewport(wide: boolean): void {
	media = installMediaQueries((query) => query === WIDE && wide);
}

const never = () => new Promise<never>(() => {});
const missingProcedure = () =>
	new RpcError({
		message: "Unknown procedure path: logs.getStorage",
		code: "INTERNAL_ERROR",
	});

beforeEach(() => {
	rpc.logs = {
		getStorage,
		query: vi.fn().mockResolvedValue({ ok: false, error: "READ_FAILED" }),
	};
	getStorage.mockReset();
	getStorage.mockResolvedValue(logStorage());
	ensureNamespaces.mockReset();
	ensureNamespaces.mockResolvedValue(undefined);
	getDeviceLog.mockReset();
	getSystemLog.mockReset();
});

afterEach(() => {
	cleanup();
	media?.restore();
	media = undefined;
	vi.restoreAllMocks();
});

function tab(name: string): HTMLElement {
	return screen.getByRole("tab", { name });
}

function region(testId: string): HTMLElement {
	return screen.getByTestId(testId);
}

describe("SystemLogsView — Downloads never wait", () => {
	it.each([true, false])(
		"shows both download rows and a loading status while the check is pending (wide=%s)",
		(wide) => {
			viewport(wide);
			getStorage.mockImplementation(never);
			render(SystemLogsView);

			expect(screen.getByTestId("log-row-device")).toBeTruthy();
			expect(screen.getByTestId("log-row-system")).toBeTruthy();
			const loading = screen.getByTestId("system-logs-loading");
			expect(loading.getAttribute("role")).toBe("status");
			expect(loading.getAttribute("aria-busy")).toBe("true");
			expect(within(loading).getByText(en.common.loading)).toBeTruthy();
			expect(screen.queryByRole("tablist")).toBeNull();
		},
	);

	it("loads the dialog's own copy, probes it, then lets Storage read its own data", async () => {
		viewport(true);
		getStorage.mockResolvedValue(logStorage());
		render(SystemLogsView);

		await screen.findByRole("tablist");
		expect(ensureNamespaces).toHaveBeenCalledExactlyOnceWith([
			"systemLogs",
			"timeline",
		]);
		expect(getStorage).toHaveBeenCalledTimes(2);
	});
});

describe("SystemLogsView — wide layout (>= 1024 px)", () => {
	beforeEach(() => {
		viewport(true);
		getStorage.mockResolvedValue(logStorage());
	});

	it("opens on Events with Raw logs beside it and no Storage tab", async () => {
		render(SystemLogsView);

		const list = await screen.findByRole("tablist");
		expect(list.getAttribute("aria-label")).toBe(en.systemLogs.tabs.label);
		expect(
			within(list)
				.getAllByRole("tab")
				.map((node) => node.textContent?.trim()),
		).toEqual([en.systemLogs.tabs.events, en.systemLogs.tabs.raw]);
		expect(tab(en.systemLogs.tabs.events).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(tab(en.systemLogs.tabs.raw).getAttribute("aria-selected")).toBe(
			"false",
		);
		expect(region("system-logs-panel-events").hidden).toBe(false);
		expect(region("system-logs-panel-raw").hidden).toBe(true);
		expect(screen.queryByTestId("system-logs-panel-storage")).toBeNull();
	});

	it("marks the selected tab through bits-ui's data-state, grows tabs to the touch token and wraps long labels", async () => {
		render(SystemLogsView);

		const list = await screen.findByRole("tablist");
		expect(list.dataset.variant).toBe("line");
		expect(list.className).toContain("w-full");
		// 8 px between touch tabs (TT-2); the line variant's own gap-1 is 4 px.
		expect(list.className.split(/\s+/)).toContain("gap-2");
		expect(list.className.split(/\s+/)).not.toContain("gap-1");
		// A long label (es "Registros sin procesar" at 375 px) wraps inside its segment
		// instead of pushing the first tab off-screen; segments share one height.
		expect(list.className.split(/\s+/)).toContain("items-stretch");
		expect(list.className.split(/\s+/)).not.toContain("items-center");
		expect(list.parentElement?.className).toContain("border-b");
		for (const trigger of within(list).getAllByRole("tab")) {
			expect(trigger.className).toContain(
				"data-[state=active]:text-foreground",
			);
			expect(trigger.className).toContain(
				"dark:data-[state=active]:text-foreground",
			);
			expect(trigger.className).toContain(
				"data-[state=active]:after:opacity-100",
			);
			expect(trigger.className).toContain("min-h-(--touch-target-min)");
			const tokens = trigger.className.split(/\s+/);
			// Only the full-width phone list wraps; the sm+ list is w-fit, sized to one line.
			expect(tokens).toEqual(
				expect.arrayContaining([
					"h-auto",
					"whitespace-normal",
					"sm:whitespace-nowrap",
					"text-center",
				]),
			);
			expect(tokens).not.toContain("whitespace-nowrap");
			expect(tokens).not.toContain("h-[calc(100%-1px)]");
		}
		expect(tab(en.systemLogs.tabs.events).dataset.state).toBe("active");
	});

	it("puts Boots, Storage and Downloads in the side column, in that order", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");

		const side = region("system-logs-side");
		expect(side.className).toContain("w-80");
		const headings = within(side)
			.getAllByRole("heading")
			.map((node) => node.textContent?.trim());
		expect(headings).toEqual([
			en.systemLogs.boots.heading,
			en.systemLogs.storage.heading,
			en.systemLogs.sharing.heading,
		]);
		expect(within(side).getByTestId("system-logs-boots")).toBeTruthy();
		expect(within(side).getByTestId("system-logs-storage")).toBeTruthy();
		const downloads = within(side).getByTestId("system-logs-downloads");
		expect(within(downloads).getByTestId("log-row-device")).toBeTruthy();
		expect(within(downloads).getByTestId("log-row-system")).toBeTruthy();
	});

	it("switches the panel when Raw logs is selected", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");

		await fireEvent.click(tab(en.systemLogs.tabs.raw));
		expect(tab(en.systemLogs.tabs.raw).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(region("system-logs-panel-raw").hidden).toBe(false);
		expect(region("system-logs-panel-events").hidden).toBe(true);
	});

	it("names each side region by its heading", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");

		for (const [testId, heading] of [
			["system-logs-boots", en.systemLogs.boots.heading],
			["system-logs-storage", en.systemLogs.storage.heading],
			["system-logs-downloads", en.systemLogs.sharing.heading],
		]) {
			expect(screen.getByRole("region", { name: heading }).dataset.testid).toBe(
				testId,
			);
		}
	});
});

describe("SystemLogsView — narrow layout (< 1024 px)", () => {
	beforeEach(() => {
		viewport(false);
		getStorage.mockResolvedValue(logStorage());
	});

	it("opens on Events with a Storage tab and no side column", async () => {
		render(SystemLogsView);

		const list = await screen.findByRole("tablist");
		expect(
			within(list)
				.getAllByRole("tab")
				.map((node) => node.textContent?.trim()),
		).toEqual([
			en.systemLogs.tabs.events,
			en.systemLogs.tabs.raw,
			en.systemLogs.tabs.storage,
		]);
		expect(tab(en.systemLogs.tabs.events).getAttribute("aria-selected")).toBe(
			"true",
		);
		expect(screen.queryByTestId("system-logs-side")).toBeNull();
		expect(screen.queryByTestId("system-logs-boots")).toBeNull();
	});

	it("shows the download rows only after the Storage tab is selected", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");

		expect(screen.queryByTestId("log-row-device")).toBeNull();
		expect(screen.queryByTestId("system-logs-storage")).toBeNull();

		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		const panel = region("system-logs-panel-storage");
		expect(panel.hidden).toBe(false);
		expect(region("system-logs-panel-events").childElementCount).toBe(0);
		expect(region("system-logs-panel-raw").childElementCount).toBe(0);
		expect(screen.getAllByTestId("log-row-device")).toHaveLength(1);
		const regions = within(panel).getByTestId(
			"system-logs-storage",
		).parentElement;
		expect(regions?.className).toContain("divide-y");
		expect(regions?.parentElement).toBe(panel);
		expect(within(panel).getByTestId("system-logs-storage")).toBeTruthy();
		const downloads = within(panel).getByTestId("system-logs-downloads");
		expect(within(downloads).getByTestId("log-row-device")).toBeTruthy();
		expect(within(downloads).getByTestId("log-row-system")).toBeTruthy();
		expect(screen.queryByTestId("system-logs-boots")).toBeNull();
	});

	it("falls back to Events when Storage moves into the side column, and returns to it", async () => {
		render(SystemLogsView);
		await screen.findByRole("tablist");
		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		media?.set((query) => query === WIDE);
		await expect
			.poll(() => tab(en.systemLogs.tabs.events).getAttribute("aria-selected"))
			.toBe("true");
		expect(
			screen.queryByRole("tab", { name: en.systemLogs.tabs.storage }),
		).toBeNull();
		expect(region("system-logs-side")).toBeTruthy();

		media?.set(() => false);
		await expect
			.poll(() => tab(en.systemLogs.tabs.storage).getAttribute("aria-selected"))
			.toBe("true");
		expect(screen.queryByTestId("system-logs-side")).toBeNull();
	});
});

describe("SystemLogsView — device version without the log viewer", () => {
	it.each([true, false])(
		"replaces the tabs with one calm notice and keeps Downloads (wide=%s)",
		async (wide) => {
			viewport(wide);
			getStorage.mockRejectedValue(missingProcedure());
			render(SystemLogsView);

			const notice = await screen.findByTestId("system-logs-unavailable");
			expect(notice.getAttribute("role")).toBeNull();
			expect(
				within(notice).getByText(en.systemLogs.unavailable.title),
			).toBeTruthy();
			expect(
				within(notice).getByText(en.systemLogs.unavailable.body),
			).toBeTruthy();
			expect(screen.queryByRole("tablist")).toBeNull();
			expect(screen.queryByTestId("system-logs-loading")).toBeNull();
			expect(screen.queryByTestId("system-logs-boots")).toBeNull();
			expect(screen.queryByTestId("system-logs-storage")).toBeNull();
			expect(screen.queryByTestId("system-logs-side")).toBeNull();
			const downloads = screen.getByTestId("system-logs-downloads");
			expect(
				notice.compareDocumentPosition(downloads) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				within(downloads).getByText(en.systemLogs.sharing.heading),
			).toBeTruthy();
			expect(within(downloads).getByTestId("log-row-device")).toBeTruthy();
		},
	);

	it("treats a client without logs procedures the same way", async () => {
		viewport(false);
		rpc.logs = undefined;
		render(SystemLogsView);

		expect(await screen.findByTestId("system-logs-unavailable")).toBeTruthy();
		expect(screen.getByTestId("log-row-device")).toBeTruthy();
	});
});

describe("SystemLogsView — check failures", () => {
	it.each([true, false])(
		"shows a recovery band, keeps Downloads, and retries (wide=%s)",
		async (wide) => {
			viewport(wide);
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			getStorage.mockRejectedValueOnce(
				new Error("Request timeout: logs.getStorage"),
			);
			getStorage.mockResolvedValueOnce(logStorage());
			render(SystemLogsView);

			const band = await screen.findByTestId("system-logs-check-failed");
			expect(band.getAttribute("role")).toBe("alert");
			expect(band.className).toContain("bg-status-warning/10");
			expect(within(band).getByText(en.errorBoundary.title)).toBeTruthy();
			expect(within(band).getByText(en.errorBoundary.description)).toBeTruthy();
			expect(screen.queryByRole("tablist")).toBeNull();
			expect(screen.queryByTestId("system-logs-unavailable")).toBeNull();
			expect(screen.getByTestId("log-row-device")).toBeTruthy();
			expect(screen.queryByTestId("system-logs-side") !== null).toBe(wide);
			expect(error).toHaveBeenCalledTimes(1);

			const retry = within(band).getByTestId("system-logs-check-retry");
			expect(retry.textContent?.trim()).toBe(en.errorBoundary.retry);
			await fireEvent.click(retry);

			expect(await screen.findByRole("tablist")).toBeTruthy();
			expect(screen.queryByTestId("system-logs-check-failed")).toBeNull();
			expect(getStorage).toHaveBeenCalledTimes(wide ? 3 : 2);
			expect(ensureNamespaces).toHaveBeenCalledTimes(2);
		},
	);

	it("shows the loading status again while a retry is in flight", async () => {
		viewport(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getStorage.mockRejectedValueOnce(
			new Error("Request timeout: logs.getStorage"),
		);
		getStorage.mockImplementationOnce(never);
		render(SystemLogsView);

		await fireEvent.click(await screen.findByTestId("system-logs-check-retry"));

		expect(screen.getByTestId("system-logs-loading")).toBeTruthy();
		expect(screen.queryByTestId("system-logs-check-failed")).toBeNull();
	});

	it("fails the same way when the view's copy cannot load", async () => {
		viewport(false);
		vi.spyOn(console, "error").mockImplementation(() => {});
		ensureNamespaces.mockRejectedValueOnce(new Error("chunk fetch failed"));
		getStorage.mockResolvedValue(logStorage());
		render(SystemLogsView);

		expect(await screen.findByTestId("system-logs-check-failed")).toBeTruthy();
		expect(screen.queryByRole("tablist")).toBeNull();
		const downloads = screen.getByTestId("system-logs-downloads");
		expect(within(downloads).queryByRole("heading")).toBeNull();
		expect(within(downloads).getByTestId("log-row-device")).toBeTruthy();
	});
});

function tokens(element: Element | null | undefined): string[] {
	return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("SystemLogsView — anatomy", () => {
	it("gives each tab panel and the side column their own scroll, and pads each region", async () => {
		viewport(true);
		getStorage.mockResolvedValue(logStorage());
		render(SystemLogsView);

		const list = await screen.findByRole("tablist");
		const view = screen.getByTestId("system-logs-view");
		expect(tokens(view)).toEqual(["flex", "min-h-0", "flex-1"]);
		expect(tokens(view.firstElementChild)).toEqual([
			"flex",
			"min-h-0",
			"min-w-0",
			"flex-1",
			"flex-col",
		]);
		expect(tokens(list.closest('[data-slot="tabs"]'))).toEqual(
			expect.arrayContaining(["min-h-0", "flex-1", "gap-0"]),
		);
		for (const tab of ["events", "raw"]) {
			expect(tokens(region(`system-logs-panel-${tab}`))).toEqual(
				expect.arrayContaining(["min-h-0", "overflow-y-auto"]),
			);
		}
		expect(tokens(region("system-logs-side"))).toEqual([
			"w-80",
			"shrink-0",
			"divide-y",
			"overflow-y-auto",
			"border-s",
		]);
		for (const id of [
			"system-logs-boots",
			"system-logs-storage",
			"system-logs-downloads",
		]) {
			const section = region(id);
			expect(section.tagName).toBe("SECTION");
			expect(tokens(section)).toEqual(["flex", "flex-col", "gap-3", "p-4"]);
			const heading = within(section).getByRole("heading");
			expect(heading.tagName).toBe("H3");
			expect(tokens(heading)).toEqual([
				"text-sm",
				"font-semibold",
				...(id === "system-logs-storage"
					? [
							"outline-none",
							"focus-visible:ring-ring/50",
							"focus-visible:ring-3",
						]
					: []),
			]);
			expect(heading.getAttribute("tabindex")).toBe(
				id === "system-logs-storage" ? "-1" : null,
			);
		}
	});

	it("shows a skeleton strip and three skeleton rows while loading", () => {
		viewport(false);
		getStorage.mockImplementation(never);
		render(SystemLogsView);

		const loading = region("system-logs-loading");
		expect(tokens(loading)).toEqual(["flex", "flex-col", "gap-3", "p-4"]);
		expect(tokens(within(loading).getByText(en.common.loading))).toEqual([
			"sr-only",
		]);
		const bones = [...loading.querySelectorAll('[data-slot="skeleton"]')];
		expect(bones.map((bone) => tokens(bone).slice(-2))).toEqual([
			["h-8", "w-48"],
			["h-12", "w-full"],
			["h-12", "w-full"],
			["h-12", "w-full"],
		]);
	});

	it("draws the not-available notice as a calm bordered note with a decorative icon", async () => {
		viewport(false);
		getStorage.mockRejectedValue(missingProcedure());
		render(SystemLogsView);

		const notice = await screen.findByTestId("system-logs-unavailable");
		expect(tokens(notice)).toEqual([
			"m-4",
			"flex",
			"items-start",
			"gap-3",
			"rounded-lg",
			"border",
			"p-4",
		]);
		const icon = notice.querySelector(":scope > svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(icon)).toEqual(
			expect.arrayContaining([
				"text-muted-foreground",
				"mt-0.5",
				"size-4",
				"shrink-0",
			]),
		);
		const title = within(notice).getByText(en.systemLogs.unavailable.title);
		expect(tokens(title)).toEqual(["text-sm", "font-semibold"]);
		expect(tokens(title.parentElement)).toEqual(["min-w-0", "space-y-1"]);
		expect(
			tokens(within(notice).getByText(en.systemLogs.unavailable.body)),
		).toEqual(["text-muted-foreground", "text-sm"]);
	});

	it("draws a failure as the amber recovery band with a small outline Retry", async () => {
		viewport(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getStorage.mockRejectedValue(new Error("Request timeout: logs.getStorage"));
		render(SystemLogsView);

		const band = await screen.findByTestId("system-logs-check-failed");
		expect(tokens(band)).toEqual([
			"border-status-warning/30",
			"bg-status-warning/10",
			"m-4",
			"flex",
			"flex-col",
			"gap-3",
			"rounded-lg",
			"border",
			"p-3",
			"sm:flex-row",
			"sm:items-center",
		]);
		const icon = band.querySelector(":scope > svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(tokens(icon)).toEqual(
			expect.arrayContaining(["text-status-warning", "size-4", "shrink-0"]),
		);
		const title = within(band).getByText(en.errorBoundary.title);
		expect(tokens(title)).toEqual(["text-sm", "font-semibold"]);
		expect(tokens(title.parentElement)).toEqual([
			"min-w-0",
			"flex-1",
			"space-y-1",
		]);
		expect(
			tokens(within(band).getByText(en.errorBoundary.description)),
		).toEqual(["text-sm"]);
		const retry = within(band).getByTestId("system-logs-check-retry");
		expect(tokens(retry)).toEqual(
			expect.arrayContaining(["shrink-0", "gap-1.5", "h-7", "border-border"]),
		);
		expect(tokens(retry.querySelector("svg"))).toContain("size-4");
		expect(screen.queryByTestId("system-logs-boots")).toBeNull();
		expect(screen.queryByTestId("system-logs-storage")).toBeNull();
		expect(
			region("system-logs-downloads").hasAttribute("aria-labelledby"),
		).toBe(false);
	});
});

describe("SystemLogsView — initial focus", () => {
	it.each([true, false])(
		"moves focus to the selected tab when the tabs appear, so arrow keys work at once (wide=%s)",
		async (wide) => {
			viewport(wide);
			getStorage.mockResolvedValue({});
			render(SystemLogsView);

			await screen.findByRole("tablist");
			await tick();
			expect(document.activeElement).toBe(tab(en.systemLogs.tabs.events));
		},
	);

	it("leaves focus where the operator already put it inside the view", async () => {
		viewport(true);
		const started = Promise.withResolvers<void>();
		const probe = Promise.withResolvers<unknown>();
		getStorage.mockImplementation(() => {
			started.resolve();
			return probe.promise;
		});
		render(SystemLogsView);
		const download = screen.getByTestId("log-download-device");
		download.focus();
		await started.promise;

		probe.resolve({});
		await screen.findByRole("tablist");
		await tick();

		expect(document.activeElement).toBe(download);
	});

	it("does not move focus when no tabs appear", async () => {
		viewport(true);
		getStorage.mockRejectedValue(missingProcedure());
		const before = document.activeElement;
		render(SystemLogsView);

		await screen.findByTestId("system-logs-unavailable");
		expect(document.activeElement).toBe(before);
	});
});

describe("SystemLogsView — Downloads keep their state across the check", () => {
	it("keeps a failed download's retry band when the check settles", async () => {
		viewport(false);
		let fail: (error: unknown) => void = () => {};
		getStorage.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getDeviceLog.mockRejectedValue(new Error("network down"));
		render(SystemLogsView);

		await fireEvent.click(screen.getByTestId("log-download-device"));
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();

		fail(new Error("Request timeout: logs.getStorage"));

		expect(await screen.findByTestId("system-logs-check-failed")).toBeTruthy();
		expect(screen.getByTestId("log-download-error")).toBeTruthy();
	});

	async function expectWorkingRetry(): Promise<void> {
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();
		const calls = getDeviceLog.mock.calls.length;
		await fireEvent.click(screen.getByTestId("log-download-retry"));
		expect(getDeviceLog).toHaveBeenCalledTimes(calls + 1);
		await tick();
		expect(screen.queryByTestId("log-download-error")).toBeNull();
	}

	it("keeps a failed download's retry band across a tab switch on a narrow screen", async () => {
		viewport(false);
		getStorage.mockResolvedValue({});
		vi.spyOn(console, "error").mockImplementation(() => {});
		getDeviceLog
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(undefined);
		render(SystemLogsView);
		await screen.findByRole("tablist");

		await fireEvent.click(tab(en.systemLogs.tabs.storage));
		await fireEvent.click(screen.getByTestId("log-download-device"));
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();

		await fireEvent.click(tab(en.systemLogs.tabs.events));
		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		await expectWorkingRetry();
	});

	it("keeps a failed download's retry band when a pending check becomes ready", async () => {
		viewport(false);
		let settle: (value: unknown) => void = () => {};
		getStorage.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getDeviceLog
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(undefined);
		render(SystemLogsView);

		await fireEvent.click(screen.getByTestId("log-download-device"));
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();
		settle({});
		await screen.findByRole("tablist");
		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		await expectWorkingRetry();
	});

	it("keeps a failed download's retry band across the 1024 px breakpoint", async () => {
		viewport(true);
		getStorage.mockResolvedValue({});
		vi.spyOn(console, "error").mockImplementation(() => {});
		getDeviceLog
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(undefined);
		render(SystemLogsView);
		await screen.findByRole("tablist");

		await fireEvent.click(screen.getByTestId("log-download-device"));
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();
		media?.set(() => false);
		await tick();
		expect(screen.queryByTestId("system-logs-side")).toBeNull();
		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		await expectWorkingRetry();
	});
});

describe("SystemLogsView — Storage region", () => {
	const usage = () =>
		screen.getByTestId("storage-usage-text").textContent?.trim();
	const used = (size: string) =>
		en.systemLogs.storage.used
			.replace("{used}", size)
			.replace("{limit}", "256\u00a0MB");

	it("fills the placeholder with a component-owned storage read", async () => {
		viewport(true);
		getStorage.mockResolvedValue(logStorage({ journalBytes: 64 * MIB }));
		render(SystemLogsView);
		await screen.findByRole("tablist");

		const storage = region("system-logs-storage");
		expect(within(storage).getByTestId("storage-section")).toBeTruthy();
		expect(usage()).toBe(used("64\u00a0MB"));
		expect(getStorage).toHaveBeenCalledTimes(2);
	});

	it("shows the latest storage reply when the Storage tab opens again", async () => {
		viewport(false);
		getStorage.mockResolvedValue(logStorage());
		const deleteOlderFiles = vi.fn().mockResolvedValue({
			ok: true,
			storage: logStorage({ journalBytes: 12 * MIB }),
			bootsBefore: 2,
			bootsAfter: 1,
		});
		rpc.logs = {
			getStorage,
			deleteOlderFiles,
			query: vi.fn().mockResolvedValue({ ok: false, error: "READ_FAILED" }),
		};
		render(SystemLogsView);
		await screen.findByRole("tablist");

		await fireEvent.click(tab(en.systemLogs.tabs.storage));
		expect(usage()).toBe(used("48\u00a0MB"));
		await fireEvent.click(screen.getByTestId("storage-delete-older"));
		await waitFor(() => expect(usage()).toBe(used("12\u00a0MB")));

		getStorage.mockResolvedValue(logStorage({ journalBytes: 12 * MIB }));
		await fireEvent.click(tab(en.systemLogs.tabs.events));
		expect(screen.queryByTestId("storage-section")).toBeNull();
		await fireEvent.click(tab(en.systemLogs.tabs.storage));

		await waitFor(() => expect(usage()).toBe(used("12\u00a0MB")));
		expect(getStorage).toHaveBeenCalledTimes(3);
	});

	it("reports an invalid Storage reply without breaking the shell", async () => {
		viewport(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getStorage.mockResolvedValue(undefined);
		render(SystemLogsView);
		await screen.findByRole("tablist");

		const storage = region("system-logs-storage");
		expect(within(storage).getByRole("heading").textContent?.trim()).toBe(
			en.systemLogs.storage.heading,
		);
		expect(
			await within(storage).findByTestId("storage-load-failed"),
		).toBeTruthy();
	});

	it("shows the reply of a retried check", async () => {
		viewport(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		getStorage.mockRejectedValueOnce(
			new Error("Request timeout: logs.getStorage"),
		);
		getStorage.mockResolvedValue(logStorage({ journalBytes: 32 * MIB }));
		render(SystemLogsView);

		await fireEvent.click(await screen.findByTestId("system-logs-check-retry"));
		await screen.findByRole("tablist");

		expect(usage()).toBe(used("32\u00a0MB"));
	});
});
