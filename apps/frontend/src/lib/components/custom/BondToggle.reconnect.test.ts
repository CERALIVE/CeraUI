// @vitest-environment jsdom
/**
 * BondToggle — reconnect-aware in-flight reconciliation (Task 29).
 *
 * An optimistic disable toggle holds a local `pending` latch while
 * `rpc.network.configure` is in flight, showing the requested OFF state. If the
 * WebSocket drops mid-operation the owning promise can be orphaned (the socket
 * is replaced on reconnect) and never run its `finally`, leaving the switch
 * stuck OFF even though the server never applied the change.
 *
 * On the reconnect edge (connection state returns to `connected`) BondToggle
 * must reconcile: clear the stuck `pending` so the control snaps back to its
 * authoritative `enabled` prop (the freshly-hydrated subscription value) rather
 * than the stale optimistic `target`.
 *
 * The connection getter is driven through a reactive `.svelte.ts` fixture mocked
 * in for `$lib/rpc/subscriptions.svelte`, so the component's reconcile `$effect`
 * fires exactly as it would against the real subscription signal.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";
import {
	resetConnectionState,
	setConnectionState,
} from "./__fixtures__/connection-state.svelte";
import BondToggle from "./BondToggle.svelte";

// Hermetic RPC: `configure` is a spy whose promise we hold "in-flight" so the
// toggle stays pending across the simulated disconnect/reconnect cycle.
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

// Route BondToggle's `getConnectionState` import to the reactive fixture so the
// test can simulate the transport dropping and returning.
vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	return await import("./__fixtures__/connection-state.svelte");
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const configure = vi.mocked(rpc.network.configure);

beforeEach(() => {
	vi.clearAllMocks();
	resetConnectionState();
});

describe("BondToggle — reconnect-aware reconciliation (Task 29)", () => {
	it("clears a stuck pending toggle on reconnect, snapping back to authoritative state", async () => {
		// `configure` never settles: models an orphaned RPC whose socket is
		// replaced on reconnect, so the toggle's own `finally` never runs.
		configure.mockImplementation(() => new Promise<void>(() => {}));

		const { getByRole } = render(BondToggle, {
			props: { name: "eth0", enabled: true },
		});

		const sw = getByRole("switch");
		// Authoritative: the link is in the bond.
		expect(sw.getAttribute("aria-checked")).toBe("true");

		// Operator toggles it OFF — no confirm gate, so it commits optimistically.
		await fireEvent.click(sw);

		// Optimistic OFF + in-flight: the RPC was reached and the switch shows the
		// requested state while pending (aria-busy true).
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(sw.getAttribute("aria-checked")).toBe("false");
		expect(sw.getAttribute("aria-busy")).toBe("true");

		// WS drops mid-operation — no reconcile yet (not a → connected edge).
		setConnectionState("disconnected");
		flushSync();
		expect(sw.getAttribute("aria-checked")).toBe("false");
		expect(sw.getAttribute("aria-busy")).toBe("true");

		// WS returns: the subscription re-hydrates authoritative state (still ON,
		// the change never landed). The reconnect edge must clear the stuck
		// pending so the switch reconciles to the authoritative `enabled` prop.
		setConnectionState("connected");
		flushSync();

		await waitFor(() => expect(sw.getAttribute("aria-busy")).toBe("false"));
		expect(sw.getAttribute("aria-checked")).toBe("true");
	});

	it("does not disturb an in-flight toggle on a steady connected tick (no false reconcile)", async () => {
		configure.mockImplementation(() => new Promise<void>(() => {}));

		const { getByRole } = render(BondToggle, {
			props: { name: "eth0", enabled: true },
		});

		const sw = getByRole("switch");
		await fireEvent.click(sw);
		await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
		expect(sw.getAttribute("aria-checked")).toBe("false");

		// A redundant `connected` write (no edge) must leave the pending toggle
		// alone — the optimistic OFF stands until the RPC genuinely settles.
		setConnectionState("connected");
		flushSync();

		expect(sw.getAttribute("aria-busy")).toBe("true");
		expect(sw.getAttribute("aria-checked")).toBe("false");
	});
});
