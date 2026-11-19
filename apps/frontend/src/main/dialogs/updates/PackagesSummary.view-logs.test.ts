// @vitest-environment jsdom
import type { UpdateState } from "@ceraui/rpc/schemas";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import PackagesSummary from "./PackagesSummary.svelte";

afterEach(cleanup);

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
