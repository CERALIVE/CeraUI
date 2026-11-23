// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";

import LogsDialogHarness from "./__fixtures__/LogsDialogHarness.svelte";
import LogsDialog from "./LogsDialog.svelte";

const rpc = vi.hoisted(() => ({
	logs: { getStorage: vi.fn(() => new Promise<unknown>(() => {})) },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));
vi.mock("$lib/helpers/SystemHelper", () => ({
	getDeviceLog: vi.fn(),
	getSystemLog: vi.fn(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({ isStreaming: false, isFullyStale: false }),
}));

afterEach(() => {
	cleanup();
});

describe("LogsDialog: the System Logs shell", () => {
	it("stays closed until it is opened", () => {
		render(LogsDialog);

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByTestId("system-logs-view")).toBeNull();
	});

	it("opens a full-viewport dialog named System Logs, even on a narrow screen", () => {
		render(LogsDialog, { props: { open: true } });

		const dialog = screen.getByRole("dialog", { name: en.settings.index.logs });
		expect(dialog.dataset.slot).toBe("dialog-content");
		expect(dialog.className).toContain("rounded-none");
		expect(dialog.className).not.toContain("max-h-[85svh]");
		expect(within(dialog).getByTestId("system-logs-view")).toBeTruthy();
		expect(within(dialog).getByTestId("log-row-device")).toBeTruthy();
	});

	it("themes text selection inside the dialog subtree and leaves scrollbars to the page palette", () => {
		render(LogsDialog, { props: { open: true } });

		const dialog = screen.getByRole("dialog", { name: en.settings.index.logs });
		const classes = dialog.className.split(/\s+/);
		expect(classes).toEqual(
			expect.arrayContaining([
				"selection:bg-status-info/30",
				"selection:text-foreground",
			]),
		);
		expect(classes.filter((name) => name.includes("scrollbar"))).toEqual([]);
	});

	it("has no title icon, description line or footer", () => {
		render(LogsDialog, { props: { open: true } });

		const title = screen.getByRole("heading", { name: en.settings.index.logs });
		expect(title.querySelector("svg")).toBeNull();
		expect(screen.queryByText(en.settings.index.logsDesc)).toBeNull();
		expect(screen.queryByText(en.settings.index.logsViewerDesc)).toBeNull();
		expect(document.querySelector("[data-app-dialog-footer]")).toBeNull();
	});

	it("shows the stream-state pill in the header, outside the title", () => {
		render(LogsDialog, { props: { open: true } });

		const pill = screen.getByTestId("system-logs-stream-pill");
		const title = screen.getByRole("heading", { name: en.settings.index.logs });
		expect(pill.closest("[data-app-dialog-header]")).not.toBeNull();
		expect(title.contains(pill)).toBe(false);
		expect(pill.textContent?.trim()).toBe(en.hud.idle);
	});

	it("puts initial focus on the selected tab, not on Close, once the tabs appear", async () => {
		rpc.logs.getStorage.mockResolvedValueOnce({});
		render(LogsDialog, { props: { open: true } });

		const events = await screen.findByRole("tab", {
			name: en.systemLogs.tabs.events,
		});
		await tick();
		expect(document.activeElement).toBe(events);
		expect(document.activeElement).not.toBe(
			screen.getByTestId("app-dialog-close"),
		);
	});

	it("hands the closed state back to its parent", async () => {
		render(LogsDialogHarness);
		expect(screen.getByTestId("harness-open").textContent).toBe("true");

		await fireEvent.click(screen.getByTestId("app-dialog-close"));

		await expect
			.poll(() => screen.getByTestId("harness-open").textContent)
			.toBe("false");
		await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
	});
});
