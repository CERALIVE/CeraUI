// @vitest-environment jsdom
/**
 * CellularSection — the RELOCATED router-mode cellular dongle (todo 53).
 *
 * Todo 43 classified these devices and todo 47 labelled them honestly, but both
 * deliberately left them in the Ethernet list. The operator overruled that:
 * "everything should be in modems, not in Ethernet. And we should be able to
 * control or configure the options that can be configured."
 *
 * So the row moves, and the move brings three obligations this file pins:
 *
 *   1. A dongle this stack reaches DIRECTLY owns a working bond toggle. It has
 *      no netns veth to defer to, and the ZTE on the bench is carrying bonded
 *      traffic right now — telling the operator "bonding is managed on its
 *      network interface row" would point at a row that no longer exists.
 *   2. The configuration surface is exactly what the device really offers. The
 *      backend reads the dongle's OWN admin API, so every value here came off
 *      the device; nothing that could not be verified is rendered as a control.
 *   3. Absence stays absence. A field the dongle did not report renders no
 *      segment at all — never a zero, never a dash that reads like a reading.
 *
 * The fixtures are the real bench topology captured over the dongles' admin
 * APIs: a SIM-less Huawei E3372 HiLink pair (one factory MAC between them, which
 * is why one is `enx0c5b8f279a64` and its twin fell back to `eth1`) and a lone
 * ZTE MF79U-class unit whose modem reports `modem_sim_undetected`.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";
import { bondDisabledReasonKey, resolveRowState } from "./cellular-row";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

function dongle(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		manufacturer: "Huawei",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			serial: "Y4QDU17621000793",
			sim: "absent",
			connection: "disconnected",
			signal_bars: 0,
			signal_max_bars: 5,
		},
		...overrides,
	} as Modem;
}

const BENCH_NETIF: NetifMessage = {
	enx0c5b8f279a64: { tp: 0, enabled: false, ip: "192.168.8.100" },
	enx344b50000000: { tp: 12, enabled: true, ip: "192.168.0.169" },
};

function renderRow(modem: Modem, netif: NetifMessage = BENCH_NETIF) {
	return render(CellularSection, {
		props: {
			modemEntries: [["1000", modem]],
			netif,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

describe("relocated router dongle — the row exists and is honest", () => {
	it("renders as a modem row carrying its own interface name", () => {
		const { container } = renderRow(dongle());
		const row = container.querySelector('[data-testid="modem-row"]');

		expect(row?.getAttribute("data-class-band")).toBe("router-ethernet");
		expect(row?.getAttribute("data-ifname")).toBe("enx0c5b8f279a64");
		expect(row?.getAttribute("data-modem-state")).toBe("router-up");
	});

	it("names the device rather than a slot label", () => {
		const { container } = renderRow(dongle());
		expect(
			container.querySelector('[data-testid="modem-name"]')?.textContent,
		).toContain("E3372");
	});

	it("draws NO signal glyph — the row has no radio status to draw one from", () => {
		const { container } = renderRow(dongle());
		expect(container.querySelector('[data-testid="modem-signal"]')).toBeNull();
	});
});

describe("bond ownership — a directly-reached dongle owns its toggle", () => {
	it("does not claim bonding lives on another row", () => {
		expect(
			bondDisabledReasonKey(
				dongle(),
				"router-ethernet",
				resolveRowState(dongle(), "router-ethernet"),
				true,
			),
		).toBeUndefined();
	});

	it("still defers to the veth row for a NETNS-claimed dongle", () => {
		const netns = dongle({
			ifname: "dg0h",
			availability_reason: "router_managed",
		});
		expect(
			bondDisabledReasonKey(
				netns,
				"router-ethernet",
				resolveRowState(netns, "router-ethernet"),
				true,
			),
		).toBe("network.cellular.bond.routerManagedLink");
	});

	it("reports the real reason when the dongle has no address yet", () => {
		const acquiring = dongle({ availability_reason: "dongle_acquiring" });
		expect(
			bondDisabledReasonKey(
				acquiring,
				"router-ethernet",
				resolveRowState(acquiring, "router-ethernet"),
				false,
			),
		).toBe("network.dongle.blockedAcquiring");
	});

	it("renders the bond toggle live for a bonded dongle", () => {
		const zte = dongle({
			ifname: "enx344b50000000",
			name: "ZTE Mobile Boardband",
			router_admin: {
				admin_url: "http://192.168.0.1",
				reachable: true,
				sim: "absent",
				connection: "disconnected",
			},
		});
		const { container } = renderRow(zte);
		const toggle = container.querySelector('button[role="switch"]');

		expect(toggle).not.toBeNull();
		expect(toggle?.hasAttribute("disabled")).toBe(false);
	});
});

describe("configuration surface — exactly what the device reported", () => {
	it("renders every fact the admin API returned, once", () => {
		const { container } = renderRow(dongle());
		const strip = container.querySelector('[data-testid="router-admin-facts"]');

		expect(
			strip?.querySelector('[data-testid="router-admin-sim"]')?.textContent,
		).toContain("No SIM");
		expect(
			strip?.querySelector('[data-testid="router-admin-connection"]')
				?.textContent,
		).toContain("Not connected");
		expect(
			strip?.querySelector('[data-testid="router-admin-signal"]')?.textContent,
		).toContain("0/5");
		expect(
			strip?.querySelector('[data-testid="router-admin-serial"]')?.textContent,
		).toContain("Y4QDU17621000793");
	});

	it("omits a segment the dongle did not report, with no dangling separator", () => {
		const bare = dongle({
			router_admin: {
				admin_url: "http://192.168.0.1",
				reachable: true,
				sim: "absent",
			},
		});
		const { container } = renderRow(bare);
		const strip = container.querySelector('[data-testid="router-admin-facts"]');

		expect(
			strip?.querySelector('[data-testid="router-admin-signal"]'),
		).toBeNull();
		expect(strip?.querySelector('[data-testid="router-admin-apn"]')).toBeNull();
		expect(strip?.textContent?.trim().endsWith("·")).toBe(false);
	});

	it("renders no fact strip at all when the probe read nothing", () => {
		const unreachable = dongle({
			router_admin: { admin_url: "http://192.168.8.1", reachable: false },
		});
		const { container } = renderRow(unreachable);

		expect(
			container.querySelector('[data-testid="router-admin-facts"]'),
		).toBeNull();
		expect(
			container
				.querySelector('[data-testid="router-admin-note"]')
				?.getAttribute("data-reachable"),
		).toBe("false");
	});

	it("STATES the admin address and never links it", () => {
		const { container } = renderRow(dongle());
		const note = container.querySelector('[data-testid="router-admin-note"]');

		expect(note?.textContent).toContain("192.168.8.1");
		expect(note?.querySelector("a")).toBeNull();
		expect(container.querySelector('a[href*="192.168.8.1"]')).toBeNull();
	});

	it("says why nothing could be read when the dongle did not answer", () => {
		const { container } = renderRow(
			dongle({
				router_admin: { admin_url: "http://192.168.8.1", reachable: false },
			}),
		);
		expect(
			container.querySelector('[data-testid="router-admin-note"]')?.textContent,
		).toContain("didn't answer");
	});

	it("never renders a machine token raw", () => {
		const { container } = renderRow(dongle());
		const text = container.textContent ?? "";

		for (const token of [
			"router_direct",
			"router-ethernet",
			"absent",
			"disconnected",
		]) {
			expect(text).not.toContain(token);
		}
	});

	it("states the dongle-owns-its-settings fact exactly once", () => {
		const { container } = renderRow(dongle());
		const notes = [
			...container.querySelectorAll('[data-testid="modem-note"]'),
		].map((n) => n.getAttribute("data-note-key"));

		expect(
			notes.filter((k) => k === "network.cellular.reason.routerManaged"),
		).toHaveLength(1);
	});

	// The whole point of the relocation: a dongle WITH a live address must never
	// be told it has none. It was the operator's original report, and the row's
	// address lookup is the seam it comes through.
	it("never claims 'no address yet' for a dongle holding one", () => {
		const { container } = renderRow(dongle());
		const notes = [
			...container.querySelectorAll('[data-testid="modem-note"]'),
		].map((n) => n.getAttribute("data-note-key"));

		expect(notes).not.toContain("network.cellular.bond.noAddress");
	});
});
