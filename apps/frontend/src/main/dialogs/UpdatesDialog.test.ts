// @vitest-environment jsdom
/**
 * UpdatesDialog — derives from the ONE unified update state machine (Todo 24).
 *
 * The load-bearing guarantee: when the backend reports `state=available`, the
 * dialog renders the update (version + packages) WITHOUT any manual re-check —
 * `checkForUpdates` is never dispatched on open. The `failed(reason)` state
 * surfaces the truthful reason and a retry affordance that re-enters checking.
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";

import UpdatesDialog from "./UpdatesDialog.svelte";

// AppDialog's responsive chrome reads `window.matchMedia` — absent in jsdom.
// Stub it to the desktop branch (mirrors LogsDialog/NetifDialog tests).
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
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

let mockState: UpdateState | undefined;
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getUpdateState: () => mockState,
}));

vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

const checkForUpdates = vi.mocked(rpc.system.checkForUpdates);

afterEach(() => {
	mockState = undefined;
	vi.clearAllMocks();
});

const AVAILABLE: UpdateState = {
	kind: "available",
	identity: { version: "abc123def456", packages: ["cerastream", "ceraui"] },
	package_count: 2,
	download_size: "12.3 MB",
};

describe("UpdatesDialog — unified state machine", () => {
	it("renders the available version WITHOUT a manual re-check (state=available)", async () => {
		mockState = AVAILABLE;
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-version").textContent).toContain(
				"abc123def456",
			);
		});
		expect(getByTestId("update-packages").textContent).toContain("cerastream");
		// The dialog already knew — it never asked the device to re-check.
		expect(checkForUpdates).not.toHaveBeenCalled();
	});

	it("surfaces the failure reason and a retry affordance (state=failed)", async () => {
		mockState = { kind: "failed", reason: "dpkg was interrupted" };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-failed-reason").textContent).toContain(
				"dpkg was interrupted",
			);
		});

		const retry = getByTestId("update-retry");
		await fireEvent.click(retry);
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("shows the up-to-date state when idle", async () => {
		mockState = { kind: "idle" };
		const { queryByTestId } = render(UpdatesDialog, { open: true });
		await waitFor(() => {
			expect(queryByTestId("update-version")).toBeNull();
			expect(queryByTestId("update-failed")).toBeNull();
		});
	});
});
