// @vitest-environment jsdom
/**
 * CellularSection — single-line rows + telemetry dedupe + 44px touch targets (T20).
 *
 * Mirrors WifiSection: the per-row `LinkIndicator`, signal-% readout, and speed
 * `Badge` (all `data-live-value`) are removed now that T19's BondedLinksSection
 * owns live per-link numbers. Identity + control rows merge into ONE `py-2.5`
 * flex line (no `.mt-2.5`), and the configure button carries the tokenized
 * touch-target min-height. KEEP: stale Badge, `noSimBond` disabledReason toggle.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";

function modem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "usb0",
		name: "Modem 1",
		network_type: { supported: ["4G"], active: "4G" },
		status: {
			connection: "connected",
			signal: 65,
			roaming: false,
			network: "Carrier",
			network_type: "4G",
		},
		...overrides,
	} as Modem;
}

function renderSection(opts: {
	modem?: Partial<Modem>;
	netif?: NetifMessage;
	stale?: Set<string>;
} = {}) {
	return render(CellularSection, {
		props: {
			modemEntries: [["modem0", modem(opts.modem)]],
			netif: opts.netif ?? { usb0: { tp: 500, enabled: true, ip: "10.0.0.5" } },
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

describe("CellularSection — T20 single-line rows + touch targets", () => {
	it("renders NO per-row telemetry (no LinkIndicator / signal% / speed Badge)", () => {
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
		expect(getByTestId("open-modem-config-dialog").className).toContain(TOUCH_MIN_CLASS);
	});

	it("KEEPS the stale Badge for an aged modem with a SIM", () => {
		const { container } = renderSection({ stale: new Set(["usb0"]) });
		expect(container.querySelector('[data-stale-interface="usb0"]')).not.toBeNull();
	});

	it("KEEPS the noSimBond disabledReason bond toggle for a no-SIM modem", () => {
		const { container } = renderSection({ modem: { no_sim: true } });
		expect(container.querySelector('[data-testid="bond-toggle-usb0"]')).not.toBeNull();
		// No SIM → no stale badge either (showStale gated on !noSim).
		expect(container.querySelector('[data-stale-interface="usb0"]')).toBeNull();
	});
});
