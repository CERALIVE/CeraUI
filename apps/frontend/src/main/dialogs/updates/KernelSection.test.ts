// @vitest-environment jsdom
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";

import { en } from "../../../tests/helpers/catalog";

const requestDialog = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/dialog-request.svelte", () => ({ requestDialog }));

import KernelSection from "./KernelSection.svelte";

afterEach(() => {
	cleanup();
	requestDialog.mockReset();
});

const kernel: NonNullable<UpdateDetails["kernel"]> = {
	booted: {
		package: "linux-image-7.2.0-ceralive-rk3588",
		version: "7.2.0-ceralive1",
	},
	candidate: null,
	state: "staging",
	version: "7.2.0-ceralive2",
	reason: null,
};

function show(
	phase: UpdateOrchestratorPhase | undefined,
	summary: UpdateDetails["kernel"],
) {
	const wire: UpdateOrchestratorWireState | undefined =
		phase === undefined
			? undefined
			: {
					schema: 1,
					phase,
					progress: { percent: 42, etaSeconds: 90 },
					failure_reason: null,
					cellular_override_id: null,
				};
	return render(KernelSection, {
		wire,
		kernel: summary,
		ready: true,
		checking: false,
		installing: false,
		onCheck: vi.fn(),
		onInstall: vi.fn(),
	});
}

it.each(["downloading", "os-staging", "syncing"] as const)(
	"does not attach %s progress to a retained kernel stage",
	(phase) => {
		// Given a retained kernel staging record and another lane's valid progress.
		// When the section renders, then it does not attribute that percent to kernel.
		show(phase, kernel);
		expect(
			screen.getByTestId("updates-kernel").getAttribute("data-phase"),
		).toBe("kernel-staging");
		expect(screen.queryByRole("progressbar")).toBeNull();
	},
);

it("offers View logs beside a kernel failure the device did not explain", () => {
	show(undefined, { ...kernel, state: "failed", reason: null });

	const status = screen.getByTestId("update-kernel-reason").parentElement;
	if (!status) throw new Error("kernel reason has no container");
	expect(
		within(status).getByTestId("update-kernel-reason").textContent,
	).toContain(en.settings.updates.kernel.reason.generic);
	expect(within(status).getByTestId("view-logs-action")).toBeTruthy();
});

it("asks for the newest kernel rollback event beside an unexplained rollback", async () => {
	show(undefined, { ...kernel, state: "rolled_back", reason: null });

	await fireEvent.click(screen.getByTestId("view-logs-action"));

	expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
		tab: "raw",
		event: { family: "update", code: "update_kernel_rolled_back" },
	});
});

it("opens the newest entries, saying the time is unknown, beside a kernel failure with no event", async () => {
	show(undefined, { ...kernel, state: "failed", reason: null });

	await fireEvent.click(screen.getByTestId("view-logs-action"));

	expect(requestDialog).toHaveBeenCalledExactlyOnceWith("logs", {
		tab: "raw",
		momentUnknown: true,
	});
});

it("offers no View logs beside a kernel failure with a named reason", () => {
	show(undefined, {
		...kernel,
		state: "failed",
		reason: "kernel_download_failed",
	});

	expect(screen.getByTestId("update-kernel-reason")).toBeTruthy();
	expect(screen.queryByTestId("view-logs-action")).toBeNull();
});

it("shows the percentage from the kernel's own live staging phase", () => {
	// Given matching live kernel progress, when rendered, then the real percent shows.
	show("kernel-staging", kernel);
	expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
		"42",
	);
});

it("missing status and summary stay unknown without granting installation", () => {
	// Given capability alone and no reported facts, when rendered, then no success is invented.
	show(undefined, undefined);
	expect(screen.getByTestId("updates-kernel").getAttribute("data-phase")).toBe(
		"unknown",
	);
	expect(
		screen.getByTestId("update-kernel-install").hasAttribute("disabled"),
	).toBe(true);
	expect(screen.queryByRole("progressbar")).toBeNull();
});
