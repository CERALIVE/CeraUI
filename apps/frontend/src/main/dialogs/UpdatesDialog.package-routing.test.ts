// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import {
	type UpdateCapabilities,
	type UpdateOrchestratorPhase,
	updateSettingsSchema,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc/client";
import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte";
import UpdatesDialog from "./UpdatesDialog.svelte";

let phase: UpdateOrchestratorPhase | undefined;
let capabilities: UpdateCapabilities;
let packagesAuto: boolean;

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			startUpdate: vi.fn(async () => ({ success: true })),
			installUpdatesNow: vi.fn(async () => ({ success: true })),
			checkForUpdates: vi.fn(async () => ({ success: true })),
			checkUpdatesNow: vi.fn(async () => ({ success: true })),
			getUpdateCapabilities: vi.fn(async () => capabilities),
			getUpdateSettings: vi.fn(async () =>
				updateSettingsSchema.parse({ packagesAuto }),
			),
			getUpdateDetails: vi.fn(async () => ({
				slots: null,
				os: { bootedVersion: null, staged: null, candidate: null },
				checks: {
					packages: {
						lastAttemptAt: null,
						lastSuccessAt: null,
						nextAttemptAt: null,
					},
					os: { lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null },
				},
				pendingCellular: null,
				transport: null,
			})),
		},
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getUpdateState: () => reactiveUpdateState.value,
	getUpdateOrchestratorState: () =>
		phase === undefined
			? undefined
			: {
					schema: 1,
					phase,
					progress: null,
					failure_reason: null,
					cellular_override_id: null,
				},
}));
vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: async (opts: { rpc: () => Promise<unknown> }) => opts.rpc(),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

beforeEach(() => {
	phase = "available";
	packagesAuto = true;
	capabilities = { mode: "capable", features: ["apt-all-packages"] };
	reactiveUpdateState.value = {
		kind: "available",
		identity: { version: "pkg", packages: ["cerastream"] },
		package_count: 1,
		actionable_count: 1,
	};
	vi.mocked(rpc.system.installUpdatesNow).mockResolvedValue({ success: true });
});
afterEach(() => {
	reactiveUpdateState.reset();
	vi.clearAllMocks();
});

async function clickPackageUpdate(): Promise<void> {
	await screen.findByTestId("update-install");
	await waitFor(() =>
		expect(screen.queryByTestId("update-details-loading")).toBeNull(),
	);
	await fireEvent.click(screen.getByTestId("update-install"));
	const confirm = await screen.findByRole("dialog", {
		name: m["general.areYouSure"](),
	});
	const button = [...confirm.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === "Update",
	);
	if (!button) throw new Error("package confirmation action missing");
	await fireEvent.click(button);
}

it.each(["available", "awaiting-idle"] as const)(
	"%s package confirmation dispatches scoped install and disables repeat clicks",
	async (next) => {
		// Given a capable package phase and a held install reply.
		phase = next;
		const reply = Promise.withResolvers<{ success: boolean }>();
		vi.mocked(rpc.system.installUpdatesNow).mockReturnValueOnce(reply.promise);
		render(UpdatesDialog, { open: true });
		// When the confirmed package button dispatches.
		await clickPackageUpdate();
		// Then it uses the scoped path and cannot be clicked while pending.
		expect(rpc.system.installUpdatesNow).toHaveBeenCalledExactlyOnceWith({
			scope: "packages",
		});
		expect(rpc.system.startUpdate).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.queryByTestId("update-install")).toBeNull(),
		);
		reply.resolve({ success: true });
		await screen.findByTestId("update-install");
	},
);

it.each(["os-available", "idle", "failed", "quarantined", "legacy"] as const)(
	"%s package confirmation preserves the base legacy route",
	async (regime) => {
		// Given known capabilities, independently of the browser's pushed phase.
		if (regime === "legacy") capabilities = { mode: "legacy", features: [] };
		else phase = regime;
		render(UpdatesDialog, { open: true });
		// When the package confirmation is accepted.
		await clickPackageUpdate();
		// Then known non-package phases retain the documented D478 residual, not a dead end.
		expect(rpc.system.startUpdate).toHaveBeenCalledOnce();
		expect(rpc.system.installUpdatesNow).not.toHaveBeenCalled();
	},
);

it("disables capable package installation until a phase is received", async () => {
	// Given a capable declaration without the orchestrator status hydrate.
	phase = undefined;
	render(UpdatesDialog, { open: true });
	await waitFor(() =>
		expect(screen.queryByTestId("update-details-loading")).toBeNull(),
	);
	// When the operator tries the package trigger.
	const button = screen.getByTestId("update-install");
	button.click();
	// Then it stays disabled and neither installer nor confirmation opens.
	expect(button.hasAttribute("disabled")).toBe(true);
	expect(
		screen.queryByRole("dialog", { name: m["general.areYouSure"]() }),
	).toBeNull();
	expect(rpc.system.startUpdate).not.toHaveBeenCalled();
	expect(rpc.system.installUpdatesNow).not.toHaveBeenCalled();
});

it("installs after Packages Check on an idle capable device with automatic packages off", async () => {
	// Given D523's idle capable device; scoped admission would refuse this phase.
	phase = "idle";
	packagesAuto = false;
	reactiveUpdateState.value = { kind: "idle", checked_at: 1_000 };
	vi.mocked(rpc.system.installUpdatesNow).mockResolvedValueOnce({
		success: false,
		error: "not_available",
	});
	render(UpdatesDialog, { open: true });
	// When the operator follows the Packages section's Check -> offer -> Update flow.
	await fireEvent.click(
		screen.getByRole("button", { name: m["general.checkForUpdates"]() }),
	);
	expect(rpc.system.checkForUpdates).toHaveBeenCalledOnce();
	reactiveUpdateState.value = {
		kind: "available",
		identity: {
			version: "pkg",
			packages: ["nginx", "nginx-common", "nginx-light"],
		},
		package_count: 3,
		actionable_count: 3,
		checked_at: 2_000,
	};
	await clickPackageUpdate();
	// Then the known idle phase keeps the working legacy route with no nothing-to-install refusal.
	expect(phase).toBe("idle");
	expect(rpc.system.checkUpdatesNow).not.toHaveBeenCalled();
	expect(rpc.system.startUpdate).toHaveBeenCalledOnce();
	expect(rpc.system.installUpdatesNow).not.toHaveBeenCalled();
	expect(screen.queryByTestId("update-action-refused")).toBeNull();
	expect(screen.queryByTestId("update-start-refused")).toBeNull();
});

it("disables package installation until a delayed declaration lands", async () => {
	// Given an offer whose capability read is still pending.
	const read = Promise.withResolvers<UpdateCapabilities>();
	vi.mocked(rpc.system.getUpdateCapabilities).mockReturnValueOnce(read.promise);
	render(UpdatesDialog, { open: true });
	const button = await screen.findByTestId("update-install");
	await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
	// When the image declaration lands and the operator confirms.
	read.resolve(capabilities);
	await clickPackageUpdate();
	// Then the capable route, never a legacy request, owns the action.
	expect(rpc.system.startUpdate).not.toHaveBeenCalled();
	expect(rpc.system.installUpdatesNow).toHaveBeenCalledExactlyOnceWith({
		scope: "packages",
	});
});

it("keeps package installation disabled after a failed declaration until Retry succeeds", async () => {
	// Given a failed capability read despite a visible package offer.
	vi.mocked(rpc.system.getUpdateCapabilities).mockRejectedValueOnce(
		new Error("read failed"),
	);
	render(UpdatesDialog, { open: true });
	await screen.findByTestId("update-details-failed");
	expect(screen.getByTestId("update-install").hasAttribute("disabled")).toBe(
		true,
	);
	// When the operator retries the existing details read and confirms the offer.
	await fireEvent.click(
		screen.getByRole("button", { name: m["settings.updates.retryDetails"]() }),
	);
	await clickPackageUpdate();
	// Then only the now-confirmed capable route dispatches.
	expect(rpc.system.startUpdate).not.toHaveBeenCalled();
	expect(rpc.system.installUpdatesNow).toHaveBeenCalledExactlyOnceWith({
		scope: "packages",
	});
});

it.each(["busy", "not_available", "stream_active"])(
	"scoped %s refusal uses existing localized feedback and re-enables",
	async (reason) => {
		// Given a server refusal after a capable package click.
		vi.mocked(rpc.system.installUpdatesNow).mockResolvedValueOnce({
			success: false,
			error: reason,
		});
		render(UpdatesDialog, { open: true });
		// When the server answers.
		await clickPackageUpdate();
		// Then the orchestrator refusal band is readable, with no legacy retry.
		const band = await screen.findByTestId("update-action-refused");
		expect(band.getAttribute("data-action")).toBe("install");
		expect(band.textContent).toContain(m["settings.updates.refusal.title"]());
		expect(band.textContent).not.toContain(reason);
		expect(screen.getByTestId("update-install").hasAttribute("disabled")).toBe(
			false,
		);
		expect(rpc.system.startUpdate).not.toHaveBeenCalled();
	},
);
