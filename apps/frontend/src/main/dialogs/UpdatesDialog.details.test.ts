// @vitest-environment jsdom
/**
 * A capable image whose details read fails (C-M3, the reviewer's sequence):
 * `getUpdateCapabilities` answers, `getUpdateDetails` rejects. The dialog must
 * say the details could not be read and leave the System section's facts
 * UNKNOWN; before this fix it told the operator the image "carries no release
 * version" and that "no newer system image has been found".
 */
import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte";

import UpdatesDialog from "./UpdatesDialog.svelte";

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
			getUpdateDetails: vi.fn(() =>
				Promise.reject(new Error("details unreadable")),
			),
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

vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(async (opts: { rpc: () => Promise<unknown> }) => {
		try {
			return await opts.rpc();
		} catch {
			return undefined;
		}
	}),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

afterEach(() => {
	reactiveUpdateState.reset();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("UpdatesDialog — a failed details read on a capable image (C-M3)", () => {
	it("reports the read failure and leaves the system facts unknown", async () => {
		// Given a capable image whose details read is rejected.
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_000 };

		// When the dialog opens.
		render(UpdatesDialog, { open: true });

		// Then the read failure is stated, with its retry.
		await waitFor(() => {
			expect(screen.getByTestId("update-details-failed")).not.toBeNull();
		});
		const section = screen.getByTestId("updates-system");
		// And the section draws no conclusion from what it never read.
		expect(
			section.querySelector(
				'[data-testid="update-system-version-unavailable"]',
			),
		).not.toBeNull();
		expect(
			section.querySelector('[data-testid="update-system-version-unknown"]'),
		).toBeNull();
		expect(
			section.querySelector('[data-testid="update-system-candidate-unknown"]'),
		).not.toBeNull();
		expect(
			section.querySelector('[data-testid="update-system-no-candidate"]'),
		).toBeNull();
		expect(section.textContent).not.toMatch(/carries no release version/);
		// And the capable image is not mislabelled as a legacy one.
		expect(screen.queryByTestId("update-legacy-notice")).toBeNull();
	});
});
