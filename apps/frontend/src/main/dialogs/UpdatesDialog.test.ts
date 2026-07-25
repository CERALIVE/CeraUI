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

// A faithful minimal osCommand: it awaits the raw rpc and hands the result back,
// which is what lets these tests observe the dialog's own reaction to a refusal.
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

const checkForUpdates = vi.mocked(rpc.system.checkForUpdates);
const startUpdate = vi.mocked(rpc.system.startUpdate);

afterEach(() => {
	mockState = undefined;
	mockPhase = "idle";
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

/** Click "Update", then confirm in the destructive "Are you absolutely sure?" dialog. */
async function clickUpdateAndConfirm(): Promise<void> {
	const trigger = [...document.querySelectorAll("button")].find((b) =>
		b.textContent?.includes("Update"),
	);
	if (!trigger) throw new Error("Update button not rendered");
	await fireEvent.click(trigger);

	await waitFor(() => {
		const footers = document.querySelectorAll("[data-app-dialog-footer]");
		if (footers.length === 0) throw new Error("confirmation not open");
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

/*
 * Live report from a Rock 5B+: Update → confirm showed "Applying…" and then, a
 * few seconds later, simply went back to the Update button. No message, no
 * overlay, and no apt process had run. The device HAD answered the RPC — with a
 * refusal the dialog never rendered.
 */
describe("UpdatesDialog — a start attempt always ends somewhere visible", () => {
	it("renders the device's own refusal reason instead of reverting in silence", async () => {
		mockState = AVAILABLE;
		startUpdate.mockResolvedValueOnce({
			success: false,
			error: "updates_disabled",
		});
		render(UpdatesDialog, { open: true });

		await clickUpdateAndConfirm();

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-start-refused"]'),
			).not.toBeNull();
		});
		expect(
			document.querySelector('[data-testid="update-start-refused-reason"]')
				?.textContent,
		).toContain("turned off on this device");
	});

	it("falls back to a generic reason when the device names none", async () => {
		mockState = AVAILABLE;
		startUpdate.mockResolvedValueOnce({ success: false });
		render(UpdatesDialog, { open: true });

		await clickUpdateAndConfirm();

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-start-refused-reason"]')
					?.textContent,
			).toContain("without giving a reason");
		});
	});

	it("calls out a start the device accepted but never reported progress for", async () => {
		mockState = AVAILABLE;
		mockPhase = "timed_out";
		render(UpdatesDialog, { open: true });

		await waitFor(() => {
			const band = document.querySelector(
				'[data-testid="update-start-refused"]',
			);
			expect(band?.textContent).toContain("never reported any progress");
		});
	});

	it("keeps offering Update after a refusal so the operator can retry", async () => {
		mockState = AVAILABLE;
		startUpdate.mockResolvedValueOnce({
			success: false,
			error: "check_unavailable",
		});
		render(UpdatesDialog, { open: true });

		await clickUpdateAndConfirm();

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-start-refused"]'),
			).not.toBeNull();
		});
		const stillOfferingUpdate = [...document.querySelectorAll("button")].some(
			(b) => b.textContent?.trim() === "Update",
		);
		expect(stillOfferingUpdate).toBe(true);
	});

	it("reports an installed update explicitly (state=success)", async () => {
		mockState = { kind: "success" };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-succeeded").textContent).toContain(
				"Update complete",
			);
		});
	});
});
