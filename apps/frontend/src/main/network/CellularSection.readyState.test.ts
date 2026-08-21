// @vitest-environment jsdom
/**
 * A REGISTERED RADIO MUST NOT LOOK LIKE A STRUGGLING ONE.
 *
 * `registered` was bucketed with `searching`/`connecting`/`scanning`: the same
 * amber pill, the same `Hourglass`. So a modem sitting ATTACHED to its home
 * network was drawn identically to one that has found no network at all, and an
 * operator reading the row on the bench board said exactly that — an hourglass
 * on a healthy radio reads as "something is stuck".
 *
 * The three rows below are rendered TOGETHER and compared against EACH OTHER,
 * because "distinct" is the property that has to hold; a per-row assertion
 * against a class name would survive re-collapsing the two states.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

/**
 * The bench Quectel RM530N-GL, verbatim from `mmcli -m 44` (2026-08-18):
 * `state: registered`, `registration: home`, `packet service state: attached`,
 * `access tech: lte`, 86 % on Movistar, `lock: sim-pin2` (non-blocking). Its
 * `wwan2` holds NO address — `ip -br -4 addr` on that board lists no such
 * interface — which is why it is absent from NETIF below.
 */
function registeredModem(): Modem {
	return {
		ifname: "wwan2",
		name: "RM530N-GL - 16855",
		network_type: { supported: ["4G", "5G"], active: "4G" },
		device_class: "usb",
		sim_lock: { required: "sim-pin2" },
		packet_service_state: "attached",
		status: {
			connection: "registered",
			signal: 86,
			roaming: false,
			network: "Movistar",
			network_type: "lte",
		},
	} as unknown as Modem;
}

/** Genuinely in flight: no network found yet. */
function searchingModem(): Modem {
	return {
		ifname: "wwan0",
		name: "SIMCOM_SIM7600G-H - 15136",
		network_type: { supported: ["4G"], active: "4G" },
		device_class: "usb",
		status: { connection: "searching", signal: 12, roaming: false },
	} as unknown as Modem;
}

/** A bearer is up and the link is carrying data. */
function connectedModem(): Modem {
	return {
		ifname: "wwan1",
		name: "FM350-GL - 99999",
		network_type: { supported: ["5G"], active: "5G" },
		device_class: "pcie-mtk",
		status: {
			connection: "connected",
			signal: 70,
			roaming: false,
			network: "Movistar",
		},
	} as unknown as Modem;
}

const NETIF: NetifMessage = {
	wwan1: { tp: 42, enabled: true, ip: "10.64.0.2" },
};

function renderRows() {
	return render(CellularSection, {
		props: {
			modemEntries: [
				["44", registeredModem()],
				["20", searchingModem()],
				["45", connectedModem()],
			],
			netif: NETIF,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

function rowFor(container: HTMLElement, ifname: string): HTMLElement {
	const row = container.querySelector<HTMLElement>(
		`[data-testid="modem-row"][data-ifname="${ifname}"]`,
	);
	if (!row) throw new Error(`no row for ${ifname}`);
	return row;
}

function stateBadge(row: HTMLElement): HTMLElement {
	const badge = row.querySelector<HTMLElement>(
		'[data-testid="modem-state-badge"]',
	);
	if (!badge) throw new Error("no state badge on this row");
	return badge;
}

function glyph(row: HTMLElement): string {
	const svg = stateBadge(row).querySelector("svg");
	if (!svg) throw new Error("no glyph in this state badge");
	return svg.innerHTML;
}

describe("a registered modem reads as ready, not as pending", () => {
	it("still says the WORD `Registered`", () => {
		const { container } = renderRows();

		expect(stateBadge(rowFor(container, "wwan2")).textContent?.trim()).toBe(
			"Registered",
		);
	});

	// `data-status-badge` is the resolved semantic tone the shared `Badge`
	// reports, so this survives a Tailwind rename while still failing if the two
	// states are re-collapsed into one register.
	it("takes a DIFFERENT colour from a searching radio", () => {
		const { container } = renderRows();
		const registered = stateBadge(rowFor(container, "wwan2"));
		const searching = stateBadge(rowFor(container, "wwan0"));

		expect(registered.getAttribute("data-status-badge")).toBe("info");
		expect(searching.getAttribute("data-status-badge")).toBe("warning");
	});

	// The other direction, and the reason this is not simply promoted to `live`:
	// the row refuses the bond for this modem, so claiming the bond's own colour
	// would make the row contradict its own note line.
	it("does NOT take the bonded colour either", () => {
		const { container } = renderRows();

		expect(
			stateBadge(rowFor(container, "wwan2")).getAttribute("data-status-badge"),
		).not.toBe(
			stateBadge(rowFor(container, "wwan1")).getAttribute("data-status-badge"),
		);
	});

	// Compared as GEOMETRY rather than as a component name: two Lucide glyphs are
	// two different path sets, and that is the only comparison an icon swap
	// cannot walk through.
	it("draws a DIFFERENT glyph from both neighbours", () => {
		const { container } = renderRows();
		const registered = glyph(rowFor(container, "wwan2"));

		expect(registered).not.toBe(glyph(rowFor(container, "wwan0")));
		expect(registered).not.toBe(glyph(rowFor(container, "wwan1")));
	});

	it("keeps the two genuinely-transitional rows on ONE register", () => {
		const { container } = renderRows();

		expect(
			stateBadge(rowFor(container, "wwan0")).getAttribute("data-status-badge"),
		).toBe("warning");
		expect(glyph(rowFor(container, "wwan0"))).toBeTruthy();
	});

	// Colour is only ever reinforcement on this row, so the calmer register must
	// not have quietly removed the reason the link is not bonding.
	it("still states, on the row, that it cannot join the bond", () => {
		const { container } = renderRows();
		const row = rowFor(container, "wwan2");

		expect(row.textContent).toContain("can't join the bonding pool");
	});
});
