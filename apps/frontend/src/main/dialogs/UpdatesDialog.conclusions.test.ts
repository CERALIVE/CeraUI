// @vitest-environment jsdom
/**
 * The Updates dialog renders only what the device's evidence supports
 * (round-3 review C: C3-2, C3-3, C3-4, and the sweep's C9).
 *
 * The legacy Packages controls: a lost start reply is "Outcome not confirmed",
 * never "The device refused the update"; a start the device ACCEPTED and then
 * never reported progress for says exactly that, and never "Nothing was
 * installed"; "System is up to date" needs a completed discovery. A settings
 * save whose reply was lost is "not confirmed", never "not saved".
 */
import type { UpdateDetails, UpdateState } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rpc } from "../../lib/rpc/client";
import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte";

import UpdatesDialog from "./UpdatesDialog.svelte";
import SystemSection from "./updates/SystemSection.svelte";

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			startUpdate: vi.fn(async () => ({ success: true })),
			checkForUpdates: vi.fn(async () => ({ success: true })),
			getUpdateCapabilities: vi.fn(async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
			})),
			getUpdateSettings: vi.fn(async () => ({
				packagesAuto: true,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: false,
			})),
			setUpdateSettings: vi.fn(() =>
				Promise.reject(new Error("Request timeout: system.setUpdateSettings")),
			),
			getUpdateDetails: vi.fn(async () => ({
				slots: null,
				os: { bootedVersion: "2026.10.70", staged: null, candidate: null },
				checks: {
					packages: {
						lastAttemptAt: 1_000,
						lastSuccessAt: 1_000,
						nextAttemptAt: null,
					},
					os: {
						lastAttemptAt: 1_000,
						lastSuccessAt: 1_000,
						nextAttemptAt: null,
					},
				},
				pendingCellular: null,
				transport: null,
			})),
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveUpdateState: state } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getUpdateState: () => state.value,
		getUpdateOrchestratorState: () => undefined,
	};
});

let mockPhase = "idle";
vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(async (opts: { rpc: () => Promise<unknown> }) => {
		try {
			return await opts.rpc();
		} catch {
			return undefined;
		}
	}),
	getOperationPhase: () => mockPhase,
	confirmOperation: vi.fn(),
}));

const startUpdate = vi.mocked(rpc.system.startUpdate);

afterEach(() => {
	reactiveUpdateState.reset();
	mockPhase = "idle";
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

const AVAILABLE: UpdateState = {
	kind: "available",
	identity: { version: "abc123def456", packages: ["cerastream"] },
	package_count: 1,
	download_size: "12.3 MB",
};

async function clickUpdateAndConfirm(): Promise<void> {
	const trigger = await screen.findByTestId("update-install");
	await fireEvent.click(trigger);
	await waitFor(() => {
		if (document.querySelectorAll("[data-app-dialog-footer]").length === 0)
			throw new Error("confirmation not open");
	});
	const footer = [...document.querySelectorAll("[data-app-dialog-footer]")].at(
		-1,
	);
	const confirm = [...(footer?.querySelectorAll("button") ?? [])].find((b) =>
		b.textContent?.includes("Update"),
	);
	if (!confirm) throw new Error("confirmation primary not rendered");
	await fireEvent.click(confirm);
}

describe("C3-4: the legacy Packages controls", () => {
	it("a lost start reply is unconfirmed, never a refusal", async () => {
		// Given an available update whose start reply is lost after the device got it.
		reactiveUpdateState.value = AVAILABLE;
		startUpdate.mockRejectedValueOnce(
			new Error("Request timeout: system.startUpdate"),
		);
		render(UpdatesDialog, { open: true });

		// When the operator starts it.
		await clickUpdateAndConfirm();

		// Then nothing claims the device refused it or did not start it.
		const band = await screen.findByTestId("update-action-unconfirmed");
		expect(band.getAttribute("data-action")).toBe("packages");
		expect(screen.queryByTestId("update-start-refused")).toBeNull();
		expect(document.body.textContent).not.toContain("refused the update");
	});

	it("a lost reply is settled once the device reports the install running", async () => {
		// Given a lost start reply.
		reactiveUpdateState.value = AVAILABLE;
		startUpdate.mockRejectedValueOnce(new Error("Request timeout"));
		render(UpdatesDialog, { open: true });
		await clickUpdateAndConfirm();
		await screen.findByTestId("update-action-unconfirmed");

		// When the device's update state shows it installing.
		reactiveUpdateState.value = {
			kind: "installing",
			progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 3 },
		};

		// Then the doubt is gone; the progress tells the story.
		await waitFor(() => {
			expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
		});
	});

	it("a lost reply settled by progress stays settled after the update finishes", async () => {
		// Given a lost start reply, settled by the device reporting the install.
		reactiveUpdateState.value = AVAILABLE;
		startUpdate.mockRejectedValueOnce(new Error("Request timeout"));
		render(UpdatesDialog, { open: true });
		await clickUpdateAndConfirm();
		await screen.findByTestId("update-action-unconfirmed");
		reactiveUpdateState.value = {
			kind: "installing",
			progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 3 },
		};
		await waitFor(() => {
			expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
		});

		// When the backend restarts after installing and reports a fresh state.
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_700_000_000_000 };

		// Then the doubt does not come back: the device already answered it.
		await screen.findByTestId("update-last-checked");
		expect(screen.queryByTestId("update-action-unconfirmed")).toBeNull();
	});

	it("an accepted start that never reported progress never says 'Nothing was installed'", async () => {
		// Given an accepted start whose progress window lapsed.
		reactiveUpdateState.value = AVAILABLE;
		mockPhase = "timed_out";
		render(UpdatesDialog, { open: true });
		await clickUpdateAndConfirm();

		// Then the band states only what the device did not report.
		const band = await screen.findByTestId("update-start-refused");
		expect(band.textContent).toContain("never reported any progress");
		expect(band.textContent).not.toContain("Nothing was installed");
	});

	it("a start whose reply has not arrived is never called 'accepted'", async () => {
		// Given a start whose reply is still on the wire when the window lapses.
		reactiveUpdateState.value = AVAILABLE;
		startUpdate.mockReturnValueOnce(new Promise(() => undefined));
		mockPhase = "timed_out";
		render(UpdatesDialog, { open: true });
		await clickUpdateAndConfirm();
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Then no band claims the device accepted it.
		expect(document.body.textContent).not.toContain("accepted the update");
	});
});

describe("C9: 'System is up to date' needs a completed discovery", () => {
	it.each<[string, UpdateState | undefined]>([
		["no status yet", undefined],
		["a check running", { kind: "checking" }],
		["idle, never stamped", { kind: "idle" }],
	])("does not say it with %s", async (_label, state) => {
		reactiveUpdateState.value = state;
		render(UpdatesDialog, { open: true });
		await screen.findByTestId("update-summary");
		expect(document.body.textContent).not.toContain("System is up to date");
	});

	it("says it after a completed discovery found nothing", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_700_000_000_000 };
		render(UpdatesDialog, { open: true });
		await waitFor(() => {
			expect(document.body.textContent).toContain("System is up to date");
		});
	});
});

describe("C3-3: a settings save whose reply was lost", () => {
	it("renders 'not confirmed', never 'did not save'", async () => {
		// Given the dialog's automation controls.
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_000 };
		render(UpdatesDialog, { open: true });
		const toggle = await screen.findByTestId("update-auto-packages");

		// When the operator turns package automation off and the reply is lost.
		await fireEvent.click(toggle);

		// Then the band states the doubt, not a failure.
		const band = await screen.findByTestId("update-settings-unconfirmed");
		expect(band.getAttribute("role")).toBe("status");
		expect(document.body.textContent).not.toContain(
			"The device did not save this change.",
		);
	});
});

describe("C3-2: the reviewer's restart combination renders as unknown", () => {
	it("package phase + lost candidate memory is not 'No newer system image'", () => {
		const details: UpdateDetails = {
			slots: null,
			os: { bootedVersion: "2026.10.70", staged: null, candidate: null },
			checks: {
				packages: {
					lastAttemptAt: 2_000,
					lastSuccessAt: 2_000,
					nextAttemptAt: null,
				},
				os: { lastAttemptAt: 2_000, lastSuccessAt: 2_000, nextAttemptAt: null },
			},
			pendingCellular: null,
			transport: null,
		};
		render(SystemSection, {
			wire: {
				schema: 1,
				phase: "available",
				progress: null,
				failure_reason: null,
				cellular_override_id: null,
			},
			details,
			channel: "stable",
			checking: false,
			installing: false,
			onCheck: () => undefined,
			onInstall: () => undefined,
		});
		expect(screen.queryByTestId("update-system-no-candidate")).toBeNull();
		expect(
			screen.getByTestId("update-system-candidate-unknown"),
		).not.toBeNull();
	});
});
