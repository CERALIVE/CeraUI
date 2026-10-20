// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte";
import UpdatesDialog from "./UpdatesDialog.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			getUpdateCapabilities: vi.fn(async () => ({
				mode: "legacy",
				features: [],
			})),
			getUpdateSettings: vi.fn(async () => ({
				packagesAuto: true,
				systemAuto: false,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: false,
			})),
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

afterEach(() => {
	cleanup();
	reactiveUpdateState.reset();
});

describe("SW2-C1: installation does not prove service restart", () => {
	it.each([
		["permitted", "same"],
		["withheld", "same"],
		["unknown", "same"],
		["permitted", "new"],
		["withheld", "new"],
		["unknown", "new"],
	])(
		"reports only installed with restart %s on a %s boot",
		async (_permission, boot) => {
			// Given the exact success wire state, which carries no restart witness.
			if (boot === "new") reactiveUpdateState.reset();
			reactiveUpdateState.value = { kind: "success" };
			// When the actual dialog renders, then restart remains unconfirmed.
			render(UpdatesDialog, { open: true });
			const band = await screen.findByTestId("update-succeeded");
			expect(band.textContent).toContain("installed");
			expect(band.textContent).toContain("not confirmed");
			expect(band.textContent).not.toContain("restarted its services");
		},
	);
});
