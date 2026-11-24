// @vitest-environment jsdom
/**
 * NetworkView — every device is listed once, with one bond switch.
 *
 * The reference mock carries two isolated (netns) router dongles: `dongle0` is
 * up with no host veth in the interface feed, and `dongle1` is still acquiring,
 * so the backend unions its `dg1h` veth into `netif` with the `dongle` marker.
 * Both have a Cellular row. Before the listing rule read that marker, `dongle1`
 * also rendered under Ethernet with a second switch, and `dongle0`'s note sent
 * the operator to an Ethernet row that did not exist.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import NetworkView from "./NetworkView.svelte";

const MODEMS: Record<string, Modem> = {
	"1000": {
		ifname: "dg0h",
		name: "dongle0",
		slot_label: "dongle0",
		device_class: "router-ethernet",
		availability_reason: "router_managed",
		network_type: { supported: [], active: null },
	} as Modem,
	"1001": {
		ifname: "dg1h",
		name: "dongle1",
		slot_label: "dongle1",
		device_class: "router-ethernet",
		availability_reason: "dongle_acquiring",
		network_type: { supported: [], active: null },
	} as Modem,
};

const NETIF: NetifMessage = {
	eth0: { tp: 0, enabled: true, ip: "192.168.1.100" },
	dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "acquiring" } },
};

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/wifi-adapter-modes.svelte", () => ({
	getWifiAdapterModeEntry: () => undefined,
	refreshWifiAdapterModes: () => Promise.resolve(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({
		links: [],
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		unbondedLinkCount: 0,
	}),
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getBluetooth: () => undefined,
	getCapabilities: () => undefined,
	getConfig: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getLinkTelemetry: () => undefined,
	getModems: () => MODEMS,
	getNetif: () => NETIF,
	getSharingDiag: () => undefined,
	getStatus: () => undefined,
	getUplinkShaper: () => undefined,
	getUplinkSteering: () => undefined,
	getUplinks: () => undefined,
	getWifi: () => ({}),
}));

describe("each isolated dongle is listed once, under Cellular", () => {
	it("renders one row and one bond switch per device", () => {
		const { container } = render(NetworkView);

		expect(
			container.querySelectorAll('[data-testid="modem-row"]'),
		).toHaveLength(2);
		for (const ifname of ["dg0h", "dg1h", "eth0"]) {
			expect(
				container.querySelectorAll(`[data-testid="bond-toggle-${ifname}"]`),
				ifname,
			).toHaveLength(1);
		}
		expect(container.querySelector('[data-testid="netif-dongle"]')).toBeNull();
	});

	it("disables each switch with its OWN link's reason, stated on screen", () => {
		const { container } = render(NetworkView);
		const ownReason: Record<string, string> = {
			dg0h: "network.cellular.bond.noAddress",
			dg1h: "network.dongle.blockedAcquiring",
		};

		for (const row of container.querySelectorAll<HTMLElement>(
			'[data-testid="modem-row"]',
		)) {
			const ifname = row.dataset.ifname ?? "";
			const note = row.querySelector(
				`[data-testid="modem-note"][data-note-key="${ownReason[ifname]}"]`,
			);
			const reason = note?.textContent?.trim() ?? "";
			expect(reason, ifname).not.toBe("");
			// The switch is NAMED by the reason the row states on screen.
			const toggle = within(row).getByRole<HTMLButtonElement>("switch", {
				name: reason,
			});
			expect(toggle.disabled, ifname).toBe(true);
		}
	});
});
