// @vitest-environment jsdom
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";

import KernelSection from "./KernelSection.svelte";

afterEach(cleanup);

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
