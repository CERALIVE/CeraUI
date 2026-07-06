// @vitest-environment jsdom
/**
 * BondToggle — confirm-gated pessimistic toggle (Task 26) + osCommand
 * composition (Task 20, live-correctness-pass).
 *
 * BondToggle's disable action is gated behind an async `onBeforeDisable` confirm
 * (Ethernet surfaces a management-interruption AlertDialog). The control is
 * PESSIMISTIC: the switch stays visually ON while the confirm is pending, and
 * only flips OFF once the user confirms AND the RPC settles.
 *
 * Task 20 additionally COMPOSED the keyed `osCommand` lifecycle onto the toggle:
 * the dirty-registry field-lock (`enabled_{name}`) is KEPT as the stale-echo
 * guard, while `osCommand` (shared key `netif:{name}`, `confirmOnResolve: true`)
 * owns the in-flight/failure lifecycle and the SINGLE failure toast. The two
 * mechanisms compose — no double feedback, no lingering re-entry guard.
 *
 * Coverage:
 *  1. Pending confirm  — switch stays ON while `onBeforeDisable` is unresolved.
 *  2. Cancel path      — confirm resolves falsy: switch returns to ON, no RPC.
 *  3. RPC-reject path  — confirm resolves truthy, RPC rejects: reverts to ON +
 *                        exactly one (osCommand-owned) failure toast.
 *  4. `success:false`  — reverts + exactly ONE toast (osCommand's).
 *  5. Double-click     — re-entry guard: exactly ONE rpc dispatched.
 *  6. Success releases — a confirmed reply resolves the async-op immediately
 *                        (no TTL lingering): a subsequent toggle dispatches again.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	destroyAsyncOperations,
	isOperationPending,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";

import BondToggle from "./BondToggle.svelte";

// Isolate the component from the live WebSocket RPC client so the unit stays
// hermetic — no socket, no env. `configure` is a spy we drive per-test.
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

// Spy on the toast surface to assert the failure path notifies exactly once.
// `osCommand` (real) imports `toast` from here, so this mock captures its toasts.
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

// BondToggle reads `getConnectionState` for reconnect-aware reconciliation
// (Task 29). Stub it to a steady `connected` so the real subscriptions module —
// which would touch the mocked-away `rpcClient` — never loads here. The
// reconcile $effect is exercised separately in BondToggle.reconnect.test.ts.
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

import { toast } from "svelte-sonner";

const configure = vi.mocked(rpc.network.configure);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	// Reset the keyed async-operation singleton so a lingering `netif:{name}`
	// phase never bleeds re-entry state into the next test.
	destroyAsyncOperations();
});

describe("BondToggle — confirm-gated pessimistic toggle (Task 26)", () => {
	it('stays ON (aria-checked="true") while onBeforeDisable is pending', async () => {
		// Never resolves: stands in for an open, un-answered confirm dialog.
		const onBeforeDisable = vi.fn(() => new Promise<boolean>(() => {}));

		const { getByRole } = render(BondToggle, {
			props: { name: "eth0", enabled: true, onBeforeDisable },
		});

		const sw = getByRole("switch");
		// Sanity: it renders ON to begin with (server says the link is in the bond).
		expect(sw.getAttribute("aria-checked")).toBe("true");

		// User toggles it OFF. The guard fires but never resolves — the confirm is
		// still on screen, so the switch MUST remain visually ON.
		await fireEvent.click(sw);

		expect(onBeforeDisable).toHaveBeenCalledTimes(1);
		// PESSIMISTIC CONTRACT: no visual flip until the confirm resolves.
		expect(sw.getAttribute("aria-checked")).toBe("true");
		// And no RPC may fire while the confirm is still pending.
		expect(configure).not.toHaveBeenCalled();
	});

	it("returns to ON and fires no RPC when the confirm is cancelled", async () => {
		// Resolves falsy: the operator dismissed the confirm dialog.
		const onBeforeDisable = vi.fn(() => Promise.resolve(false));

		const { getByRole } = render(BondToggle, {
			props: { name: "eth0", enabled: true, onBeforeDisable },
		});

		const sw = getByRole("switch");
		expect(sw.getAttribute("aria-checked")).toBe("true");

		await fireEvent.click(sw);

		// Wait for the guard to settle, then assert the control never left ON and
		// the RPC was never reached.
		await waitFor(() => expect(onBeforeDisable).toHaveBeenCalledTimes(1));
		expect(sw.getAttribute("aria-checked")).toBe("true");
		expect(configure).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("reverts to ON and shows exactly one failure toast when the RPC rejects post-confirm", async () => {
		// Confirm proceeds, but the backend rejects the configure call.
		const onBeforeDisable = vi.fn(() => Promise.resolve(true));
		configure.mockRejectedValueOnce(new Error("link is last active"));

		const { getByRole } = render(BondToggle, {
			props: { name: "eth0", enabled: true, onBeforeDisable },
		});

		const sw = getByRole("switch");
		expect(sw.getAttribute("aria-checked")).toBe("true");

		await fireEvent.click(sw);

		// The RPC is reached once the confirm resolves truthy.
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(configure).toHaveBeenCalledWith({
			name: "eth0",
			ip: undefined,
			enabled: false,
		});

		// osCommand owns the SINGLE failure toast (copy `network.os.operationFailed`);
		// BondToggle must NOT toast a second time. The switch reverts to its
		// authoritative ON state (the `enabled` prop).
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
	});
});

describe("BondToggle — osCommand composition (Task 20)", () => {
	it("reverts and shows exactly ONE toast on a structured success:false reply", async () => {
		// Enable path (no onBeforeDisable gate): backend refuses with success:false.
		configure.mockResolvedValueOnce({ success: false, error: "netif_failed" });

		const { getByRole } = render(BondToggle, {
			props: { name: "wlan0", enabled: false },
		});

		const sw = getByRole("switch");
		expect(sw.getAttribute("aria-checked")).toBe("false");

		await fireEvent.click(sw); // toggle → enable (target true)

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		// Exactly ONE failure toast, owned by osCommand — not a second from BondToggle.
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastSuccess).not.toHaveBeenCalled();
		// No confirming echo is coming → the lock releases to the authoritative
		// prior `enabled` (false), so the switch reverts to OFF.
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
	});

	it("dispatches exactly ONE rpc on a rapid double-click (re-entry guard)", async () => {
		// Never resolves: keeps the `netif:wlan0` op pending across both clicks.
		const d = deferred<{ success: boolean; applied?: { enabled: boolean } }>();
		configure.mockReturnValueOnce(d.promise);

		const { getByRole } = render(BondToggle, {
			props: { name: "wlan0", enabled: false },
		});

		const sw = getByRole("switch");
		await fireEvent.click(sw); // dispatch 1 → in flight
		await Promise.resolve();
		expect(configure).toHaveBeenCalledTimes(1);

		// Second click while the shared-key op is still pending → NO second dispatch.
		await fireEvent.click(sw);
		await Promise.resolve();
		expect(configure).toHaveBeenCalledTimes(1);

		// Settle so no promise dangles into teardown.
		d.resolve({ success: true, applied: { enabled: true } });
	});

	it("releases the async-op immediately on a confirmed reply (no TTL lingering)", async () => {
		configure.mockResolvedValue({ success: true, applied: { enabled: true } });

		const { getByRole } = render(BondToggle, {
			props: { name: "wlan0", enabled: false },
		});

		const sw = getByRole("switch");
		await fireEvent.click(sw); // enable

		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		// `confirmOnResolve` transitions the key straight to `confirmed` — it never
		// lingers `pending` to TTL. So a follow-up toggle dispatches again at once.
		await waitFor(() => expect(isOperationPending("netif:wlan0")).toBe(false));

		await fireEvent.click(sw); // toggle again (disable) — must not be blocked
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
	});
});
