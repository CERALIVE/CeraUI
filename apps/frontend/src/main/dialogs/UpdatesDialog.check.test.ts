// @vitest-environment jsdom
/**
 * "Check for updates" must visibly do something.
 *
 * Live on a Rock 5B+: clicking it changed NOTHING for 11 s — `aria-busy` stayed
 * false, the label never became "Checking…", the summary stayed "System is up to
 * date" — while the device's own log proved the check ran and succeeded in 1.8 s.
 *
 * The dialog cancelled its own spinner: it latched completion on "the state is no
 * longer `checking`", and `checking` is BELOW `available` in the update state
 * machine, so a device that already knows about an update never publishes a
 * `checking` frame at all. The condition was therefore true on the very first
 * flush after the click — before the RPC had even been dispatched.
 *
 * Completion is now latched on a NEW `checked_at`, which every completed cycle
 * stamps regardless of which state it lands in.
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";
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
	return { getUpdateState: () => state.value };
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

const checkForUpdates = vi.mocked(rpc.system.checkForUpdates);

afterEach(() => {
	reactiveUpdateState.reset();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

const AVAILABLE: UpdateState = {
	kind: "available",
	identity: { version: "abc123def456", packages: ["cerastream"] },
	package_count: 1,
	download_size: "12.3 MB",
};

function checkButton(): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((b) =>
		/Check for updates|Checking/.test(b.textContent ?? ""),
	);
	if (!button) throw new Error("check button not rendered");
	return button as HTMLButtonElement;
}

describe("UpdatesDialog — the check reports that it is running", () => {
	it("stays busy until the device stamps a completed check", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1000 };
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		// Pre-fix this read "false" here: the dialog had already cancelled itself.
		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("true");
		});
		expect(checkButton().textContent).toContain("Checking");
		expect(checkForUpdates).toHaveBeenCalledTimes(1);

		reactiveUpdateState.value = { kind: "idle", checked_at: 2000 };
		flushSync();

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("false");
		});
	});

	it("stays busy on a device that never publishes a `checking` frame", async () => {
		// `available` outranks `checking`, so this device's state does not change
		// at all while the check runs — the exact case the old latch mis-read.
		reactiveUpdateState.value = { ...AVAILABLE, checked_at: 1000 };
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("true");
		});

		reactiveUpdateState.value = { ...AVAILABLE, checked_at: 2000 };
		flushSync();

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("false");
		});
	});
});

describe("UpdatesDialog — a completed check leaves evidence", () => {
	it("shows when the device last checked instead of a bare 'up to date'", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_700_000_000_000 };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-last-checked").textContent).toContain(
				"Last checked",
			);
		});
	});

	it("omits the line on a device that has never checked", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		const { queryByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(queryByTestId("update-last-checked")).toBeNull();
		});
	});
});

describe("UpdatesDialog — a check that fails says so, never 'up to date'", () => {
	it("renders the typed reason for an unreachable repository", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "refresh_failed",
			checked_at: 1000,
		};
		const { getByTestId, queryByText } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed").textContent).toContain(
				"Couldn't check for updates",
			);
		});
		expect(getByTestId("update-check-failed-reason").textContent).toContain(
			"couldn't reach the package repositories",
		);
		// The lie this replaces.
		expect(queryByText("System is up to date")).toBeNull();
	});

	it("renders the typed reason for an unreadable discovery", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "discovery_failed",
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed-reason").textContent).toContain(
				"couldn't read the result",
			);
		});
	});

	it("still offers a retry after a failed check", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "refresh_failed",
		};
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});
});

describe("UpdatesDialog — a refused check names itself", () => {
	it("renders the device's reason instead of doing nothing", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		checkForUpdates.mockResolvedValueOnce({
			success: false,
			error: "check_unavailable",
		});
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-check-refused-reason"]')
					?.textContent,
			).toContain("busy streaming or installing");
		});
		expect(checkButton().getAttribute("aria-busy")).toBe("false");
	});

	it("falls back to a generic reason when the device names none", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		checkForUpdates.mockResolvedValueOnce({ success: false });
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-check-refused-reason"]')
					?.textContent,
			).toContain("without giving a reason");
		});
	});
});
