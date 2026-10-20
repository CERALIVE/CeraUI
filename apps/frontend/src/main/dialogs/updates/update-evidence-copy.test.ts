// @vitest-environment jsdom
/**
 * Update copy claims only what the device's evidence carries (early oracle F5,
 * F7, 2026-10-13).
 *
 * F5: a pending cellular approval proves "this candidate, this size, approval
 * pending"; the producer also asks when no connection is KNOWN to be unmetered
 * (unknown-cost Wi-Fi, an unreadable inventory), so it is never "only a
 * cellular connection" and never certainly mobile data.
 * F7: a withheld package is "not included in this update"; only `layer:
 * platform` says it ships with the next OS image and only `kept_back` says it
 * was held back. A progress frame whose total is unknown is indeterminate,
 * never 100 %.
 */
import type {
	UpdateDetails,
	UpdatePackage,
	UpdateState,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { reactiveUpdateState } from "../../../tests/fixtures/reactive-subscriptions.svelte";
import UpdatesDialog from "../UpdatesDialog.svelte";
import PackagesSummary from "./PackagesSummary.svelte";
import UpdateCellularSection from "./UpdateCellularSection.svelte";

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
				mode: "legacy",
				features: [],
			})),
			getUpdateSettings: vi.fn(() => Promise.reject(new Error("unused"))),
			getUpdateDetails: vi.fn(() => Promise.reject(new Error("unused"))),
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveUpdateState: state } = await import(
		"../../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getUpdateState: () => state.value,
		getUpdateOrchestratorState: () => undefined,
	};
});

vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(async (opts: { rpc: () => Promise<unknown> }) => opts.rpc()),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

afterEach(() => {
	cleanup();
	reactiveUpdateState.reset();
	document.body.innerHTML = "";
});

const SETTINGS = {
	packagesAuto: true,
	systemAuto: true,
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	channel: "stable",
	allowPackagesOverCellular: true,
	allowSystemOverCellular: false,
} as const;

const PENDING: NonNullable<UpdateDetails["pendingCellular"]> = {
	id: "2026.10.76",
	sizeBytes: 734_003_200,
};

describe("F5: a pending cellular approval", () => {
	it("names the candidate and its size without claiming a cellular link", () => {
		render(UpdateCellularSection, {
			props: {
				settings: SETTINGS,
				system: true,
				saving: false,
				pending: PENDING,
				approving: false,
				onSave: async () => true,
				onApprove: () => undefined,
			},
		});
		const body =
			screen.getByTestId("update-cellular-pending-body").textContent ?? "";

		expect(body).toContain("No connection known to be unmetered is available.");
		expect(body).toContain("2026.10.76");
		expect(body).toContain("metered connection or one whose cost is unknown");
		expect(body).not.toContain("Only a cellular connection");
		expect(body).not.toContain("mobile data");
	});
});

function available(packages: UpdatePackage[]): UpdateState {
	return {
		kind: "available",
		identity: {
			version: "abc123def456",
			packages: packages.map((p) => p.name),
		},
		package_count: packages.length,
		packages,
		actionable_count: 0,
		checked_at: 1_000,
	};
}

function band(packages: UpdatePackage[]): HTMLElement {
	render(PackagesSummary, {
		props: { updateState: available(packages), nextCheck: undefined },
	});
	return screen.getByTestId("update-platform-band");
}

describe("F7: the withheld band states each package's own evidence", () => {
	it("a package the device only marked not actionable is not called an OS-image package", () => {
		const shown = band([{ name: "libfoo1", layer: "app", actionable: false }]);

		expect(shown.textContent).toContain("Not included in this update");
		expect(shown.textContent).toContain("libfoo1");
		expect(shown.textContent).not.toContain("Ships with the next OS image");
		expect(shown.textContent).not.toContain("Held back by the system");
	});

	it("a platform package carries the producer's next-OS-image meaning on its own row", () => {
		const shown = band([
			{ name: "libfoo1", layer: "app", actionable: false },
			{
				name: "gstreamer1.0-rockchip-ceralive",
				layer: "platform",
				actionable: false,
			},
		]);
		const rows = within(shown).getAllByRole("listitem");

		expect(rows[0]?.textContent).not.toContain("Ships with the next OS image");
		expect(rows[1]?.textContent).toContain("Ships with the next OS image");
	});

	it("a held-back package says held back, not next OS image", () => {
		const shown = band([
			{
				name: "ceralive-device",
				layer: "app",
				kept_back: true,
				actionable: false,
			},
		]);

		expect(shown.textContent).toContain("Held back by the system");
		expect(shown.textContent).not.toContain("Ships with the next OS image");
	});
});

describe("F7: package progress with an unknown total", () => {
	async function progressBar(state: UpdateState): Promise<HTMLElement> {
		reactiveUpdateState.value = state;
		render(UpdatesDialog, { props: { open: true } });
		const section = await screen.findByTestId("updates-packages");
		await waitFor(() => {
			if (within(section).queryByRole("progressbar") === null)
				throw new Error("no progress bar yet");
		});
		return within(section).getByRole("progressbar");
	}

	it("is indeterminate, never a completed 100 %", async () => {
		const bar = await progressBar({
			kind: "downloading",
			progress: { downloading: 0, unpacking: 0, setting_up: 0, total: 0 },
		});

		expect(bar.getAttribute("data-state")).toBe("indeterminate");
		expect(bar.getAttribute("aria-valuenow")).toBeNull();
	});

	it("still reports a measured percentage when the total is known", async () => {
		const bar = await progressBar({
			kind: "installing",
			progress: { downloading: 2, unpacking: 1, setting_up: 0, total: 2 },
		});

		expect(bar.getAttribute("aria-valuenow")).toBe("50");
	});
});
