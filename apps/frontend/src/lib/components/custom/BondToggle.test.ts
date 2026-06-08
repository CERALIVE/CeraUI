// @vitest-environment jsdom
/**
 * BondToggle — confirm-gated pessimistic toggle (Task 26).
 *
 * BondToggle's disable action is gated behind an async `onBeforeDisable` confirm
 * (Ethernet surfaces a management-interruption AlertDialog). The control is
 * PESSIMISTIC: the switch stays visually ON while the confirm is pending, and
 * only flips OFF once the user confirms AND the RPC settles.
 *
 * The original bug (Task 7 RED repro, now GREEN): the shadcn `Switch` wraps
 * bits-ui with a `$bindable` checked, and bits-ui optimistically writes its own
 * `checked = !checked` on click BEFORE `onBeforeDisable()` resolves — flipping
 * `aria-checked` to "false" behind an open confirm dialog. Task 26 fixed this by
 * driving the Switch with a Svelte function binding
 * (`bind:checked={() => displayed, toggle}`): `displayed` is the only read
 * source so `aria-checked` cannot diverge from it, and every write is routed
 * through `toggle`, which awaits the confirm before mutating any state.
 *
 * Coverage:
 *  1. Pending confirm  — switch stays ON while `onBeforeDisable` is unresolved.
 *  2. Cancel path      — confirm resolves falsy: switch returns to ON, no RPC.
 *  3. RPC-failure path — confirm resolves truthy, RPC rejects: reverts to ON +
 *                        surfaces an error toast.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";

import BondToggle from "./BondToggle.svelte";

// Isolate the component from the live WebSocket RPC client so the unit stays
// hermetic — no socket, no env. `configure` is a spy we drive per-test.
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

// Spy on the toast surface to assert the RPC-failure path notifies the operator.
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

beforeEach(() => {
	vi.clearAllMocks();
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

	it("reverts to ON and shows an error toast when the RPC rejects post-confirm", async () => {
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

		// On rejection the operator is notified and the switch reverts to its
		// authoritative ON state (the `enabled` prop).
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError).toHaveBeenCalledWith("link is last active");
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
	});
});
