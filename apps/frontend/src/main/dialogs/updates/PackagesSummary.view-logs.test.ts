// @vitest-environment jsdom
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestDialog = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/dialog-request.svelte", () => ({ requestDialog }));

import PackagesSummary from "./PackagesSummary.svelte";

afterEach(() => {
	cleanup();
	requestDialog.mockReset();
});

function show(updateState: UpdateState): void {
	render(PackagesSummary, { updateState });
}

function action(inside: string): HTMLElement | null {
	return within(screen.getByTestId(inside)).queryByTestId("view-logs-action");
}

describe("PackagesSummary: View logs beside a log-pointing outcome", () => {
	it("offers it under a preflight refusal that points to the logs", () => {
		show({
			kind: "update_preflight_failed",
			preflight_reason: "insufficient_space",
		});

		expect(action("update-preflight-failed")?.className).toContain("mt-2");
	});

	it("offers nothing under a preflight refusal that names its own fix", () => {
		show({ kind: "update_preflight_failed", preflight_reason: "probe_failed" });

		expect(action("update-preflight-failed")).toBeNull();
	});

	it("offers it under a failure the device did not explain", () => {
		show({ kind: "failed", reason: "dpkg was interrupted" } as UpdateState);

		expect(action("update-failed")?.className).toContain("mt-2");
	});

	it("offers nothing under a failure with a known reason", () => {
		show({ kind: "failed", reason: "updates_disabled" } as UpdateState);

		expect(action("update-failed")).toBeNull();
	});

	it("offers it under the cleanup warning of a successful install", () => {
		show({
			kind: "success",
			cleanup_warning: "post_clean_failed",
		} as UpdateState);

		expect(action("update-succeeded")?.className).toContain("mt-2");
	});

	it("offers nothing after a clean successful install", () => {
		show({ kind: "success" } as UpdateState);

		expect(action("update-succeeded")).toBeNull();
	});
});

// These outcomes are persisted states without a time, usually read long after
// the device reported them, so the click is never their moment.
describe("PackagesSummary: View logs opens the outcome's moment, not the click", () => {
	async function viewLogs(inside: string): Promise<void> {
		const button = action(inside);
		if (!button) throw new Error(`no View logs under ${inside}`);
		await fireEvent.click(button);
	}

	it("opens the newest entries when the package failure has only a package-set identity", async () => {
		show({
			kind: "failed",
			reason: "dpkg was interrupted",
			identity: { version: "packages-1", packages: ["ceralive"] },
		});

		await viewLogs("update-failed");

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			momentUnknown: true,
		});
	});

	it("links an unexplained transaction failure by its event correlation id", async () => {
		show({
			kind: "failed",
			reason: "dpkg was interrupted",
			failure_id: "52fd5e45-627d-4a10-a263-9129880c4330",
		});

		await viewLogs("update-failed");

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			event: {
				family: "update",
				code: "update_failed",
				id: "52fd5e45-627d-4a10-a263-9129880c4330",
			},
		});
	});

	it("opens the newest entries, saying the time is unknown, under a preflight refusal", async () => {
		show({
			kind: "update_preflight_failed",
			preflight_reason: "insufficient_space",
		});

		await viewLogs("update-preflight-failed");

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			momentUnknown: true,
		});
	});

	it("opens the newest entries, saying the time is unknown, under a cleanup warning", async () => {
		show({
			kind: "success",
			cleanup_warning: "post_clean_failed",
		} as UpdateState);

		await viewLogs("update-succeeded");

		expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
			tab: "raw",
			momentUnknown: true,
		});
	});
});
