// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "../../../tests/helpers/catalog";

const requestDialog = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/dialog-request.svelte", () => ({ requestDialog }));

import ViewLogsAction from "./ViewLogsAction.svelte";

const NOW = 1_700_000_000_000;

beforeEach(() => {
	requestDialog.mockReset();
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("ViewLogsAction", () => {
	it("renders a View logs button beside a message that points to System Logs", () => {
		render(ViewLogsAction, {
			messageKey: "notifications.streamStartInternalFailed",
		});

		const action = screen.getByRole("button", {
			name: en.notifications.viewLogs,
		});
		expect(action.dataset.testid).toBe("view-logs-action");
		expect(action.textContent?.trim()).toBe(en.notifications.viewLogs);
		// A quiet secondary action: compact outline, never the lime primary fill.
		expect(action.className).toContain("border-border");
		expect(action.className).not.toContain("bg-primary");
		expect(action.className).toContain("h-7");
		expect(action.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		// Its leading icon would set the inline baseline and lift it above a
		// text-only neighbour such as a notice's own action.
		expect(action.classList).toContain("align-top");
	});

	it("renders nothing beside a message that does not point to the logs", () => {
		render(ViewLogsAction, { messageKey: "notifications.saved" });

		expect(screen.queryByTestId("view-logs-action")).toBeNull();
	});

	it("renders nothing when there is no message key", () => {
		render(ViewLogsAction, { messageKey: undefined });

		expect(screen.queryByTestId("view-logs-action")).toBeNull();
	});

	it("requests the Logs dialog on Raw logs at the message's time", async () => {
		render(ViewLogsAction, {
			messageKey: "live.startFailure.retriedThenFailed",
			at: 1234,
		});
		// A surface that passes no onViewLogs must still get a clean click; jsdom
		// reports a listener's exception as a window error, not a test failure.
		const errors: unknown[] = [];
		const collect = (event: ErrorEvent) => errors.push(event.error);
		window.addEventListener("error", collect);

		await fireEvent.click(screen.getByTestId("view-logs-action"));
		window.removeEventListener("error", collect);

		expect(requestDialog).toHaveBeenCalledTimes(1);
		expect(requestDialog).toHaveBeenCalledWith("logs", {
			tab: "raw",
			at: 1234,
		});
		expect(errors).toEqual([]);
	});

	it("uses the time of the click when the message's time is unknown", async () => {
		render(ViewLogsAction, {
			messageKey: "settings.updates.credentials.rejectedBody",
		});
		vi.setSystemTime(NOW + 9000);

		await fireEvent.click(screen.getByTestId("view-logs-action"));

		expect(requestDialog).toHaveBeenCalledWith("logs", {
			tab: "raw",
			at: NOW + 9000,
		});
	});

	it("tells the placing surface once the logs were requested", async () => {
		const onViewLogs = vi.fn(() => {
			expect(requestDialog).toHaveBeenCalledTimes(1);
		});
		render(ViewLogsAction, {
			messageKey: "settings.updates.kernel.reason.generic",
			onViewLogs,
		});

		await fireEvent.click(screen.getByTestId("view-logs-action"));

		expect(onViewLogs).toHaveBeenCalledTimes(1);
	});

	it("takes the placing site's spacing", () => {
		render(ViewLogsAction, {
			messageKey: "settings.updates.refusal.generic",
			class: "mt-2",
		});

		const action = screen.getByTestId("view-logs-action");
		expect(action.classList).toContain("mt-2");
		expect(action.classList).toContain("align-top");
	});
});
