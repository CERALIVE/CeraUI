// @vitest-environment jsdom
/**
 * EthernetSection — single-line rows + touch targets + confirm-gated disable (T20).
 *
 * The per-row speed `Badge` (data-live-value) is removed (T19 owns telemetry).
 * Identity + control rows merge into ONE `py-2.5` flex line (no `.mt-2.5`), and
 * the configure button carries the tokenized touch-target min-height.
 *
 * CRITICAL KEEP (T20 QA failure scenario): disabling a wired link still routes
 * through the management-interruption confirm dialog BEFORE any RPC dispatch —
 * the BondToggle's `onBeforeDisable` guard must fire and the configure RPC must
 * NOT be reached until the operator confirms.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";

import EthernetSection from "./EthernetSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const configure = vi.mocked(rpc.network.configure);
const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";

function entry(partial: Partial<NetifEntry> = {}): NetifEntry {
	return { tp: 1000, enabled: true, ip: "192.168.1.2", ...partial };
}

function renderSection(opts: { entry?: Partial<NetifEntry>; stale?: Set<string> } = {}) {
	return render(EthernetSection, {
		props: {
			wiredEntries: [["eth0", entry(opts.entry)]],
			isFullyStale: false,
			staleInterfaces: opts.stale ?? new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("EthernetSection — T20 single-line rows + touch targets", () => {
	it("renders NO per-row speed Badge (data-live-value removed)", () => {
		const { container } = renderSection();
		expect(container.querySelectorAll("[data-live-value]").length).toBe(0);
	});

	it("merges identity + controls into ONE row (py-2.5, no .mt-2.5 control row)", () => {
		const { container } = renderSection();
		expect(container.querySelector(".mt-2\\.5")).toBeNull();
		expect(container.querySelector(".divide-y > .py-2\\.5")).not.toBeNull();
		expect(container.querySelector(".divide-y > .py-4")).toBeNull();
	});

	it("configure button carries the 44px touch-min class under data-layout-mode=touch", () => {
		document.documentElement.dataset.layoutMode = "touch";
		const { getByTestId } = renderSection();
		expect(getByTestId("open-netif-dialog").className).toContain(TOUCH_MIN_CLASS);
	});

	it("KEEPS the stale Badge for an aged enabled wired link", () => {
		const { container } = renderSection({ stale: new Set(["eth0"]) });
		expect(container.querySelector('[data-stale-interface="eth0"]')).not.toBeNull();
	});

	it("disabling the bond toggle triggers the confirm dialog BEFORE any RPC dispatch", async () => {
		const { getByTestId } = renderSection();
		const sw = getByTestId("bond-toggle-eth0");
		// Server says the link is in the bond → switch renders ON.
		expect(sw.getAttribute("aria-checked")).toBe("true");

		// Toggle OFF → BondToggle's onBeforeDisable guard opens the confirm dialog.
		await fireEvent.click(sw);

		// The management-interruption confirm dialog is on screen (portal → body).
		await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
		// And NO configure RPC has been dispatched while the confirm is pending.
		expect(configure).not.toHaveBeenCalled();
	});
});
