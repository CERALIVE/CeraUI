import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";

const requestDialog = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/dialog-request.svelte", () => ({ requestDialog }));

import { viewLogs, viewLogsToast, viewNoticeLogs } from "./view-logs";

const NOW = 1_700_000_000_000;

beforeEach(() => {
	requestDialog.mockReset();
	vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("viewLogs", () => {
	it("opens System Logs on Raw logs around the given moment", () => {
		viewLogs(1234);

		expect(requestDialog).toHaveBeenCalledTimes(1);
		expect(requestDialog).toHaveBeenCalledWith("logs", {
			tab: "raw",
			at: 1234,
		});
	});

	it("uses the moment of the call when the message's time is unknown", () => {
		viewLogs();

		expect(requestDialog).toHaveBeenCalledWith("logs", { tab: "raw", at: NOW });
	});
});

describe("viewNoticeLogs", () => {
	it("asks for an update notice's own timeline event, and its live arrival as a fallback", () => {
		viewNoticeLogs({
			name: "update:os-rollback:txn-9",
			receivedAt: 42,
			arrivedLive: true,
		});

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			at: 42,
			event: { family: "update", code: "update_os_rollback", id: "txn-9" },
		});
	});

	it("keeps every colon after the kind in the update id", () => {
		viewNoticeLogs({
			name: "update:refused:apt:42",
			receivedAt: 42,
			arrivedLive: false,
		});

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			event: { family: "update", code: "update_refused", id: "apt:42" },
		});
	});

	it("opens a live notice without an event at its arrival", () => {
		viewNoticeLogs({
			name: "stream_recovery_failed",
			receivedAt: 42,
			arrivedLive: true,
		});

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			at: 42,
		});
	});

	it("names no moment for a notice first seen in a connection's replay that has no event", () => {
		viewNoticeLogs({
			name: "stream_recovery_failed",
			receivedAt: 42,
			arrivedLive: false,
		});

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
		});
	});
});

describe("viewLogsToast", () => {
	it("gives a toast no action for a message that does not point to the logs", () => {
		expect(viewLogsToast("notifications.saved")).toBeUndefined();
		expect(viewLogsToast(undefined)).toBeUndefined();
		expect(requestDialog).not.toHaveBeenCalled();
	});

	it("gives a log-pointing toast a View logs action for the given moment", () => {
		const options = viewLogsToast(
			"notifications.streamStartInternalFailed",
			42,
		);

		expect(options?.action.label).toBe(en.notifications.viewLogs);
		expect(requestDialog).not.toHaveBeenCalled();
		options?.action.onClick();
		expect(requestDialog).toHaveBeenCalledWith("logs", { tab: "raw", at: 42 });
	});

	it("keeps the moment the toast was raised, not the moment it is clicked", () => {
		const options = viewLogsToast("live.startFailure.notRetriable");
		vi.advanceTimersByTime(5000);
		options?.action.onClick();

		expect(requestDialog).toHaveBeenCalledWith("logs", { tab: "raw", at: NOW });
	});
});
