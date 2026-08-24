// @vitest-environment jsdom
/**
 * EthernetSection — a `shared-lan` port renders HONESTLY (todo 15).
 *
 * The device hands such a port to NetworkManager's `ipv4.method shared`, stamps
 * `NETIF_ERR_SHAREDLAN`, and drops it from `genSrtlaIpList()`. So the row must
 * not read like an uplink in either direction:
 *
 *   1. It says WHAT the port is (the Shared LAN identity badge) and WHAT its
 *      client zone is doing (a state badge whose WORD, not merely its colour,
 *      names `serving` / `starting`).
 *   2. It never says "Connected" and never says "Off" — `enabled` is BOND
 *      membership here, and a zone that is up and serving is neither.
 *   3. It names WHY the port carries no bonded traffic, on screen AND as the
 *      disabled bond toggle's accessible name (a kiosk touchscreen cannot hover).
 *
 * And an `uplink` port — plus a row the device published NO role for — are
 * byte-unchanged by all of it.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import EthernetSection from "./EthernetSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function renderRows(rows: [string, NetifEntry][]) {
	return render(EthernetSection, {
		props: {
			wiredEntries: rows,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

/** A shared port whose NM profile has come up and leased its gateway address. */
const SERVING: [string, NetifEntry] = [
	"eth1",
	{
		tp: 0,
		enabled: false,
		ip: "10.42.0.1",
		error: "shared LAN",
		ethRole: "shared-lan",
	},
];

/** The same port before NM's shared profile has taken. */
const STARTING: [string, NetifEntry] = [
	"eth1",
	{ tp: 0, enabled: false, error: "shared LAN", ethRole: "shared-lan" },
];

/** An ordinary bonded uplink, role explicitly published. */
const UPLINK: [string, NetifEntry] = [
	"eth0",
	{ tp: 4096, enabled: true, ip: "192.168.1.50", ethRole: "uplink" },
];

/** A row the device published no role for at all (dongle veth, older backend). */
const UNCLAIMED: [string, NetifEntry] = [
	"eth2",
	{ tp: 4096, enabled: true, ip: "192.168.1.60" },
];

describe("EthernetSection — a shared-LAN port is not an uplink", () => {
	it("names what the port IS, with a word and a glyph", () => {
		const { getByTestId } = renderRows([SERVING]);

		const badge = getByTestId("netif-eth-role");
		expect(badge.getAttribute("data-eth-role")).toBe("shared-lan");
		expect(badge.textContent).toContain("Shared LAN");
		// The concept is explained where the claim is made.
		expect(badge.getAttribute("title")).toContain("shares");
		expect(badge.querySelector("svg")).not.toBeNull();
	});

	it("shows the client-zone state as a WORD, serving", () => {
		const { getByTestId } = renderRows([SERVING]);

		const zone = getByTestId("netif-eth-role-zone");
		expect(zone.getAttribute("data-zone")).toBe("serving");
		expect(zone.textContent?.trim()).toBe("Serving clients");
		expect(zone.querySelector("svg")).not.toBeNull();
	});

	it("shows STARTING — never 'serving' — before the zone has an address", () => {
		const { getByTestId } = renderRows([STARTING]);

		const zone = getByTestId("netif-eth-role-zone");
		expect(zone.getAttribute("data-zone")).toBe("starting");
		expect(zone.textContent?.trim()).toBe("Starting");
	});

	it("never renders the bond-membership word as a link state", () => {
		// `enabled: false` on a shared port is the device's own bond exclusion. The
		// retired render printed "Off" for it, which reads as a dead port.
		const { container } = renderRows([SERVING]);
		expect(container.textContent).not.toContain("Connected");
		expect(container.textContent).not.toContain("Off");
		// The address is still reported.
		expect(container.textContent).toContain("10.42.0.1");
	});

	it("names WHY it is out of the bond, on screen", () => {
		const { getByTestId } = renderRows([SERVING]);

		const hint = getByTestId("netif-eth-role-excluded-hint");
		expect(hint.textContent).toContain("Not in the bond");
		expect(hint.textContent).toContain("Uplink");
	});

	it("disables the bond toggle and carries the same reason as its accessible name", () => {
		const { getByTestId } = renderRows([SERVING]);

		const toggle = getByTestId("bond-toggle-eth1");
		expect(toggle.hasAttribute("disabled")).toBe(true);

		const reason = getByTestId("netif-eth-role-excluded-hint")
			.textContent?.trim()
			.replace(/\s+/g, " ");
		const label = toggle.getAttribute("aria-label")?.replace(/\s+/g, " ");
		expect(label).toBe(reason);
	});

	it("still says EXCLUDED in the bond vocabulary the other rows use", () => {
		const { getByTestId } = renderRows([SERVING]);
		expect(getByTestId("bond-state-eth1").textContent).toContain("Excluded");
	});

	it("keeps Configure reachable — it is the only way back to Uplink", () => {
		const { getAllByTestId } = renderRows([SERVING]);
		expect(getAllByTestId("open-netif-dialog").length).toBe(1);
	});
});

describe("EthernetSection — every other row is untouched", () => {
	it("an UPLINK row shows no role badge, no zone, no exclusion reason", () => {
		const { queryByTestId, container } = renderRows([UPLINK]);

		expect(queryByTestId("netif-eth-role")).toBeNull();
		expect(queryByTestId("netif-eth-role-zone")).toBeNull();
		expect(queryByTestId("netif-eth-role-excluded-hint")).toBeNull();
		expect(container.textContent).toContain("Connected");
	});

	it("an uplink's bond toggle stays live", () => {
		const { getByTestId } = renderRows([UPLINK]);
		const toggle = getByTestId("bond-toggle-eth0");
		expect(toggle.hasAttribute("disabled")).toBe(false);
	});

	it("a row with NO published role is rendered exactly as before", () => {
		const { queryByTestId, getByTestId, container } = renderRows([UNCLAIMED]);

		expect(queryByTestId("netif-eth-role")).toBeNull();
		expect(container.textContent).toContain("Connected");
		expect(getByTestId("bond-toggle-eth2").hasAttribute("disabled")).toBe(
			false,
		);
	});

	it("a shared port does not leak its treatment onto a sibling uplink", () => {
		const { getByTestId, container } = renderRows([UPLINK, SERVING]);

		expect(getByTestId("bond-toggle-eth0").hasAttribute("disabled")).toBe(
			false,
		);
		expect(getByTestId("bond-toggle-eth1").hasAttribute("disabled")).toBe(true);
		// Exactly one role badge, on the shared row.
		expect(
			container.querySelectorAll('[data-testid="netif-eth-role"]').length,
		).toBe(1);
	});
});
