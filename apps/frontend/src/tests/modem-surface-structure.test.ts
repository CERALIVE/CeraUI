// @vitest-environment jsdom
/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The `DESIGN.md` pass-1 structural gate, across ALL THREE modem surfaces.
 *
 * Pass 1's stop condition has two mechanical halves, and neither had a gate:
 * every surface LEADS with state/signal/action, and no surface exceeds TWO
 * levels of disclosure. `CellularSection.hierarchy.test.ts` decides IH-1 for the
 * ROW and stays the authority there; nothing decided it for the two dialogs,
 * which is exactly how `RouterDongleDialog` spent four waves opening its status
 * card with the device's NAME — restating the dialog title directly above it —
 * while the connection state and the radio sat underneath.
 *
 * IT IS DELIBERATELY CROSS-SURFACE. Each surface's own suite mounts one
 * component and asks component questions; the rule these three share is an
 * ARCHITECTURAL one, and a per-file copy of it is how the three drift into three
 * readings of one contract.
 *
 * ── WHAT COUNTS AS A DISCLOSURE ─────────────────────────────────────────────
 *
 * Three different implementations are in play — `CollapsibleSection`, the
 * Cellular row's own copy of that shape, and the SMS card's `{#if}`-gated fold —
 * so keying on any one of their markers would measure a third of the tree. What
 * all three DO share is the ARIA contract every disclosure owes: a trigger
 * carrying `aria-expanded` + `aria-controls`, naming the body it expands. Depth
 * is then counted from the BODIES, not from markup nesting, so a future fourth
 * implementation is covered the moment it is accessible.
 */

import type { Modem } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CellularSection from "../main/network/CellularSection.svelte";
import { resetModemsFeed } from "./helpers/modem-feed.svelte";

const connected = vi.hoisted(() => ({ value: true }));

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setUsbMode: vi.fn(),
			setRouterControl: vi.fn(),
			configure: vi.fn(),
			scan: vi.fn(),
			getSms: vi.fn(async () => ({ success: true, messages: [] })),
		},
	},
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => connected.value,
		getConnectionState: () => "connected",
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/**
 * §2 tiers 1-3 — what a surface must lead with.
 *
 * The `ConnectionStateBlock` root is matched by `data-connection-state` rather
 * than by a test id, so both dialogs are covered by ONE selector and a surface
 * that adopts the shared block later is covered for free.
 */
const STATE_SIGNAL_ACTION = [
	"[data-connection-state]",
	'[data-testid="modem-state-badge"]',
	"[data-no-sim]",
	'[data-testid="modem-signal"]',
	'[data-testid="modem-router-signal"]',
	'[data-testid="modem-router-signal-state"]',
	'[data-testid="dongle-signal"]',
	'[data-testid="modem-details-toggle"]',
	'[data-testid="open-modem-config-dialog"]',
	'[data-testid="open-modem-unlock-dialog"]',
	'[data-testid="open-router-admin"]',
	'[data-testid="dongle-open-admin"]',
].join(",");

/** §2 tiers 4-5 — identity, and the hardware trivia below it. */
const IDENTITY_OR_HARDWARE = [
	"[data-identified]",
	"[data-hardware-tag]",
	'[data-testid="modem-detail-card"]',
	'[data-testid="dongle-unit"]',
].join(",");

/**
 * A disclosure trigger, excluding the popup widgets that share the attribute.
 *
 * A bits-ui `Select.Trigger` is `role="combobox"` + `aria-expanded`, and a
 * popover trigger carries `aria-haspopup` — neither is a disclosure, and
 * counting them would report a depth that has nothing to do with how deeply the
 * operator's content is buried.
 */
function disclosureTriggers(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>(
			"[aria-expanded][aria-controls]:not([role='combobox']):not([aria-haspopup])",
		),
	];
}

function disclosureBody(trigger: HTMLElement): HTMLElement | null {
	const id = trigger.getAttribute("aria-controls");
	return id ? document.getElementById(id) : null;
}

/**
 * How many disclosures an operator must open before this trigger is reachable.
 *
 * A body that does not resolve contributes nothing rather than throwing: the SMS
 * fold's `aria-controls` target is `{#if}`-gated (a collapsed inbox holds no
 * message text in the DOM at all, which is a privacy property), so while shut it
 * legitimately names an element that does not exist. It can only ever
 * UNDER-count, and no trigger sits inside it.
 */
function disclosureDepth(trigger: HTMLElement, all: HTMLElement[]): number {
	let depth = 1;
	for (const other of all) {
		if (other === trigger) continue;
		const body = disclosureBody(other);
		if (body?.contains(trigger)) depth += 1;
	}
	return depth;
}

function maxDisclosureDepth(): number {
	const triggers = disclosureTriggers();
	return triggers.reduce(
		(deepest, trigger) => Math.max(deepest, disclosureDepth(trigger, triggers)),
		0,
	);
}

/** First match in DOM order, or `-1` when the selector matches nothing. */
function firstIndex(selector: string): number {
	const all = [...document.querySelectorAll("*")];
	return all.findIndex((el) => el.matches(selector));
}

function expectLeadsWithStateSignalAction(surface: string): void {
	const lead = firstIndex(STATE_SIGNAL_ACTION);
	const demoted = firstIndex(IDENTITY_OR_HARDWARE);

	// Both halves must be present or the ordering claim is vacuous — a surface
	// that rendered neither tier would "pass" an ordering assertion trivially.
	expect(
		lead,
		`${surface}: no state/signal/action element rendered`,
	).toBeGreaterThanOrEqual(0);
	expect(
		demoted,
		`${surface}: no identity/hardware element rendered — the probe proves nothing`,
	).toBeGreaterThanOrEqual(0);
	expect(
		lead,
		`${surface}: identity/hardware trivia precedes the first state/signal/action element`,
	).toBeLessThan(demoted);
}

/** A directly-managed radio the network is refusing — carries every tier. */
function managedRadio(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		device_class: "usb",
		slot_label: "SIM 1",
		network_type: { supported: ["5G", "4G"], active: "4G" },
		registration_rejection: { error: "location-area-not-allowed" },
		status: {
			connection: "searching",
			signal: 81,
			roaming: true,
			network: "TIGO",
			network_type: "LTE",
		},
		stable_key: "platform-xhci-hcd.0-usb-1:2",
		usb_mode: "qmi",
		firmware_revision: "RM520NGLAAR01A08M4G",
		cell_info: {
			tech: "nr",
			band: "n78",
			cell_id: "0x1A2B3C",
			rsrp: -92,
			provenance: { source: "qmi", observed_at: 1_770_000_000 },
		},
		config: { apn: "", autoconfig: true, roaming: true },
	} as Modem;
}

/** The bench HiLink, admin probe answered in full. */
function routerDongle(): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			sim: "absent",
			connection: "disconnected",
			signal_bars: 0,
			signal_max_bars: 5,
			apn: "3gnet",
			firmware: "22.333.01.00.00",
			imei: "866850029360451",
			serial: "Y4QDU17621000872",
			details: { network_type: "LTE", provider: "Claro", band: "B4" },
		},
	} as unknown as Modem;
}

function renderSection(): void {
	const entries: [string, Modem][] = [
		["0", managedRadio()],
		["1", routerDongle()],
	];
	render(CellularSection, {
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

async function renderModemDialog(): Promise<void> {
	const { default: ModemConfigDialog } = await import(
		"../main/dialogs/ModemConfigDialog.svelte"
	);
	render(ModemConfigDialog, {
		props: { open: true, modem: managedRadio(), deviceId: "0" },
	});
}

async function renderDongleDialog(): Promise<void> {
	const { default: RouterDongleDialog } = await import(
		"../main/dialogs/RouterDongleDialog.svelte"
	);
	render(RouterDongleDialog, {
		props: { open: true, deviceId: "router-1", modem: routerDongle() },
	});
}

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	connected.value = true;
	resetModemsFeed();
});

describe("every modem surface leads with state, signal and action", () => {
	it("the Cellular rows do", () => {
		renderSection();
		expectLeadsWithStateSignalAction("CellularSection");
	});

	/*
	  It did NOT, and this is the finding pass 1 fixed. The card opened with
	  `IdentityBlock` — the device's own name, one line under the dialog header
	  that already carries it — so the two facts an operator taps a misbehaving
	  dongle to read, what it is doing and how its radio is, were the third and
	  fourth things on the surface. Identity is §2 tier 4 and this is the surface
	  that needs it least: the header answers "which device", and the only thing
	  the block carries that the header does not (the class hint, the note for a
	  device that named itself nothing) is context for the readings above it.
	*/
	it("the router-dongle dialog does", async () => {
		await renderDongleDialog();
		expectLeadsWithStateSignalAction("RouterDongleDialog");
	});

	/*
	  Its lead strip stated the CARRIER and the signal and never the connection at
	  all, so the dialog reached FROM a row badged "Registration denied" answered
	  a different question than the row did — and the rejection sentence that
	  explains it lived only on the row behind. It renders the shared
	  `ConnectionStateBlock` now, which is why `[data-connection-state]` is the
	  selector this file leads with.
	*/
	it("the modem-config dialog does", async () => {
		await renderModemDialog();
		expectLeadsWithStateSignalAction("ModemConfigDialog");
	});
});

describe("no modem surface exceeds two levels of disclosure", () => {
	it("the Cellular rows fold once", () => {
		renderSection();
		expect(disclosureTriggers().length).toBeGreaterThan(0);
		expect(maxDisclosureDepth()).toBe(1);
	});

	it("the router-dongle dialog folds once", async () => {
		await renderDongleDialog();
		expect(disclosureTriggers().length).toBeGreaterThan(0);
		expect(maxDisclosureDepth()).toBe(1);
	});

	/*
	  Two, and two is the ceiling rather than the target: Advanced holds the four
	  instrument cards, and the diagnostics table and the SMS inbox each keep their
	  own fold inside it. The SMS one is not redundant with the outer disclosure —
	  it is `{#if}`-gated because a real SIM's inbox carries one-time codes, and
	  the outer body deliberately stays MOUNTED. A third level would put an
	  operator three taps from a reading, which is where "reorganised" stops being
	  distinguishable from "deleted".
	*/
	it("the modem-config dialog folds twice, and no deeper", async () => {
		await renderModemDialog();
		const triggers = disclosureTriggers();
		const depths = triggers.map((t) => disclosureDepth(t, triggers));

		expect(depths).toContain(2);
		expect(Math.max(...depths)).toBe(2);
	});
});
