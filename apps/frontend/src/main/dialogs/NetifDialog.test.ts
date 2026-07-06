// @vitest-environment jsdom
/**
 * NetifDialog — definitive apply/fail feedback for static-IP/DHCP save
 * (Task 20, live-correctness-pass).
 *
 * The save now routes through the keyed `osCommand` machine on the SHARED
 * resource key `netif:{name}` (the SAME key BondToggle uses), with
 * `confirmOnResolve: true`. The reply's `{ success, applied }` is definitive:
 *  - `success: true`  → success toast (`network.os.saved`) THEN close.
 *  - `success: false` → osCommand's single failure toast; dialog STAYS open with
 *                       the form value preserved.
 *  - RPC throw        → osCommand's single failure toast; dialog STAYS open.
 *  - shared-key busy  → a bond toggle (or another save) on THIS iface is pending:
 *                       refuse with the standard busy feedback, no second dispatch.
 *                       A save on a DIFFERENT iface proceeds.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { rpc } from "$lib/rpc";
import {
	beginOperation,
	destroyAsyncOperations,
} from "$lib/rpc/async-operation.svelte";

import NetifDialog from "./NetifDialog.svelte";

// Hermetic RPC: `configure` is a spy we drive per-test. NetifDialog imports the
// `rpc` barrel, so mock `$lib/rpc`.
vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

// `osCommand` (real) and NetifDialog both toast through svelte-sonner.
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "svelte-sonner";

const configure = vi.mocked(rpc.network.configure);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { ip: "", tp: 0, enabled: true, ...overrides };
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

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
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	// Reset the keyed async-operation singleton so a lingering `netif:{name}`
	// phase never bleeds re-entry state into the next test.
	destroyAsyncOperations();
});

describe("NetifDialog — definitive save feedback (Task 20)", () => {
	it("on success: toasts saved and closes the dialog (DHCP omits ip)", async () => {
		configure.mockResolvedValueOnce({
			success: true,
			applied: { name: "eth0", enabled: true },
		});

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		await fireEvent.click(saveButton());

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		// Empty IP === DHCP → ip MUST be omitted (undefined), never "".
		expect(configure).toHaveBeenCalledWith({
			name: "eth0",
			ip: undefined,
			enabled: true,
		});
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
		// Confirmed success closes the dialog → the Save button unmounts.
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
		);
	});

	it("on success:false: keeps the dialog open, toasts once, preserves the form value", async () => {
		configure.mockResolvedValueOnce({ success: false, error: "netif_failed" });

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		// Operator typed a static IP; it must survive a failed save.
		const ipInput = screen.getByPlaceholderText(/./) as HTMLInputElement;
		await fireEvent.input(ipInput, { target: { value: "10.0.0.5" } });

		await fireEvent.click(saveButton());

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledWith({
			name: "eth0",
			ip: "10.0.0.5",
			enabled: true,
		});
		// osCommand owns the single failure toast; NetifDialog does not add one.
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastSuccess).not.toHaveBeenCalled();
		// Dialog STAYS open (Save button present) and the typed IP is preserved.
		expect(saveButton()).toBeTruthy();
		expect(ipInput.value).toBe("10.0.0.5");
	});

	it("on RPC throw: keeps the dialog open and toasts once", async () => {
		configure.mockRejectedValueOnce(new Error("socket dropped"));

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		await fireEvent.click(saveButton());

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastSuccess).not.toHaveBeenCalled();
		// A throw is not a confirmed success → dialog stays open.
		expect(saveButton()).toBeTruthy();
	});

	it("cross-surface guard: refuses a save while a bond toggle op on the SAME iface is pending", async () => {
		// Simulate BondToggle's in-flight osCommand on the shared key.
		beginOperation("netif:eth0");

		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: iface() },
		});

		await fireEvent.click(saveButton());
		await Promise.resolve();

		// Shared-key busy guard: NO second dispatch, calm busy feedback, dialog open.
		expect(configure).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(saveButton()).toBeTruthy();
	});

	it("cross-surface guard: a save on a DIFFERENT iface proceeds while another iface is busy", async () => {
		// A pending op on eth0 must NOT block a save on wlan0 (distinct key).
		beginOperation("netif:eth0");
		configure.mockResolvedValueOnce({
			success: true,
			applied: { name: "wlan0", enabled: true },
		});

		render(NetifDialog, {
			props: { open: true, name: "wlan0", iface: iface() },
		});

		await fireEvent.click(saveButton());

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledWith({
			name: "wlan0",
			ip: undefined,
			enabled: true,
		});
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
	});
});
