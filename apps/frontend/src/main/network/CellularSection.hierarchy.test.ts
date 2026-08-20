// @vitest-environment jsdom
/**
 * IH-1 — no hardware tag above the first state/signal/action element.
 *
 * `DESIGN.md` §2 ranks a row's content state → signal → action → identity →
 * hardware tags, and IH-1 is the half of that ranking a test can actually
 * decide: it is a DOM-ORDER assertion, not a judgement about visual weight.
 *
 * The rule had one violation, and it was the row's very first pill. `slot_label`
 * ("SIM 1") is a hardware tag — which physical socket the thing is in — and it
 * led the badge line, so the first pill an operator's eye and a screen reader
 * both reached was the one fact on the row nothing can be done about, ahead of
 * whether the modem is registered at all.
 *
 * THE FIXTURE SET IS THE POINT. A single-row check would pass on a row whose
 * tags happen not to render, so this drives every class the section supports —
 * a directly-managed radio, a SIM-less one, and a router dongle whose only
 * signal reading comes from its own admin API — and asserts the rule per row.
 */
import type { Modem } from "@ceraui/rpc/schemas";
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
 * The three priority tiers IH-1 arbitrates between, as selectors.
 *
 * `modem-details-toggle` and the configure/unlock buttons are ACTIONS; the two
 * signal readouts are SIGNAL; the state/carrier/roaming/no-SIM pills are STATE.
 */
const STATE_SIGNAL_ACTION = [
	'[data-testid="modem-state-badge"]',
	'[data-testid="modem-carrier-badge"]',
	'[data-testid="modem-roaming-badge"]',
	'[data-testid="modem-signal"]',
	'[data-testid="modem-router-signal"]',
	'[data-testid="modem-router-signal-state"]',
	'[data-testid="modem-details-toggle"]',
	'[data-testid="open-modem-config-dialog"]',
	'[data-testid="open-modem-unlock-dialog"]',
	"[data-no-sim]",
].join(",");

const HARDWARE_TAG = "[data-hardware-tag]";

function mmManaged(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		device_class: "usb",
		slot_label: "SIM 1",
		network_type: { supported: ["5G", "4G"], active: "4G" },
		status: {
			connection: "connected",
			signal: 81,
			roaming: true,
			network: "TIGO",
			network_type: "LTE",
		},
	} as Modem;
}

function simless(): Modem {
	return {
		ifname: "wwan1",
		name: "SIMCOM SIM7600G-H",
		device_class: "usb",
		slot_label: "SIM 2",
		no_sim: true,
		network_type: { supported: ["4G"], active: null },
	} as Modem;
}

function routerDongle(): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		slot_label: "USB 3",
		network_type: { supported: ["4G"], active: "4G" },
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			sim: "present",
			connection: "connected",
			signal_bars: 3,
			signal_max_bars: 5,
		},
	} as Modem;
}

function renderRows(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif: Object.fromEntries(
				entries.map(([, entry], i) => [
					entry.ifname,
					{ tp: 0, enabled: true, ip: `10.0.0.${i + 5}` },
				]),
			),
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

/** Index of the first match within the row, or -1. `-1` means "not present". */
function firstIndexOf(row: HTMLElement, selector: string): number {
	const all = [...row.querySelectorAll<HTMLElement>("*")];
	return all.findIndex((el) => el.matches(selector));
}

const FIXTURES: [string, () => Modem][] = [
	["a directly-managed radio", mmManaged],
	["a modem with no SIM in the slot", simless],
	["a router-mode dongle", routerDongle],
];

describe("IH-1 — hardware tags never precede state/signal/action", () => {
	it.each(FIXTURES)(
		"Given %s, When the row renders, Then the first hardware tag comes after the first state/signal/action element",
		(_label, build) => {
			const { container } = renderRows([["0", build()]]);
			const row = container.querySelector<HTMLElement>(
				'[data-testid="modem-row"]',
			);
			expect(row).not.toBeNull();
			if (row === null) return;

			const firstPrimary = firstIndexOf(row, STATE_SIGNAL_ACTION);
			const firstTag = firstIndexOf(row, HARDWARE_TAG);

			// A row that renders no state/signal/action element at all would make
			// the ordering assertion vacuous, so it is a failure in its own right.
			expect(firstPrimary).toBeGreaterThanOrEqual(0);
			if (firstTag >= 0) expect(firstTag).toBeGreaterThan(firstPrimary);
		},
	);

	it("Given every fixture on one section, When rendered, Then the rule holds per row", () => {
		const { container } = renderRows(
			FIXTURES.map(([, build], i) => [String(i), build()] as [string, Modem]),
		);
		const rows = [
			...container.querySelectorAll<HTMLElement>('[data-testid="modem-row"]'),
		];
		expect(rows).toHaveLength(FIXTURES.length);

		for (const row of rows) {
			const firstPrimary = firstIndexOf(row, STATE_SIGNAL_ACTION);
			const firstTag = firstIndexOf(row, HARDWARE_TAG);
			expect(firstPrimary).toBeGreaterThanOrEqual(0);
			if (firstTag >= 0) expect(firstTag).toBeGreaterThan(firstPrimary);
		}
	});

	// NON-VACUITY: the slot badge must actually BE a tagged hardware tag and must
	// actually render, or the ordering assertion above is checking nothing.
	it("Given a modem in a labelled slot, When rendered, Then the slot pill is a tagged hardware tag", () => {
		const { container } = renderRows([["0", mmManaged()]]);
		const slot = container.querySelector<HTMLElement>(
			'[data-testid="modem-slot-badge"]',
		);
		expect(slot).not.toBeNull();
		expect(slot?.getAttribute("data-hardware-tag")).toBe("slot");
	});

	// The demotion must not have DELETED the tag — §2 demotes hardware tags, it
	// does not remove them.
	it.each(FIXTURES)(
		"Given %s, When rendered, Then its slot label is still on screen",
		(_label, build) => {
			const subject = build();
			const { container } = renderRows([["0", subject]]);
			expect(
				container.querySelector('[data-testid="modem-slot-badge"]')
					?.textContent,
			).toContain(subject.slot_label);
		},
	);
});
