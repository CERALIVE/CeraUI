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

/*
  RETARGETED, not weakened. Every fixture in this block used to carry the bench
  dongles' `sim: "absent"`, which is now a HIGHER-PRECEDENCE bond refusal than
  any of the reasons these tests were written to pin — so with the original
  fixtures they would all have asserted "no SIM" and stopped covering the
  property they exist for. They keep their exact assertions and gain a SIM, so
  each one still proves the one rule it names. The no-SIM rule that displaced
  them gets its own block below.
*/
function bondableDongle(overrides: Partial<Modem> = {}): Modem {
	const base = dongle(overrides);
	return {
		...base,
		router_admin: { ...base.router_admin, sim: "present" },
	} as Modem;
}

describe("bond ownership — a directly-reached dongle owns its toggle", () => {
	it("does not claim bonding lives on another row", () => {
		expect(
			bondDisabledReasonKey(
				bondableDongle(),
				"router-ethernet",
				resolveRowState(bondableDongle(), "router-ethernet"),
				true,
			),
		).toBeUndefined();
	});

	it("still defers to the veth row for a NETNS-claimed dongle", () => {
		const netns = bondableDongle({
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
		const acquiring = bondableDongle({
			availability_reason: "dongle_acquiring",
		});
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
		const zte = bondableDongle({
			ifname: "enx344b50000000",
			name: "ZTE Mobile Boardband",
			router_admin: {
				admin_url: "http://192.168.0.1",
				reachable: true,
				sim: "present",
				connection: "connected",
			},
		});
		const { container } = renderRow(zte);
		const toggle = container.querySelector('button[role="switch"]');

		expect(toggle).not.toBeNull();
		expect(toggle?.hasAttribute("disabled")).toBe(false);
	});
});

/*
  THE DEFECT THIS FILE HAD NO COVERAGE FOR.

  A `router-ethernet` dongle reports its SIM slot through its OWN admin API
  (`router_admin.sim`), not through ModemManager's `no_sim`, and the bond gate
  only ever read the second. So the SAME condition that forced a directly-managed
  modem's toggle off left a dongle's live — and on the bench two SIM-less dongles
  really were in the srtla source-IP list, spending bond slots on uplinks with no
  WAN behind them.
*/
describe("a SIM-less dongle cannot be toggled into the bond", () => {
	it("refuses the toggle on the dongle's own SIM verdict", () => {
		const simless = dongle();
		expect(
			bondDisabledReasonKey(
				simless,
				"router-ethernet",
				resolveRowState(simless, "router-ethernet"),
				true,
			),
		).toBe("network.view.noSimBond");
	});

	it("renders that toggle DISABLED, whatever the netif entry still says", () => {
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
		// The netif entry deliberately still reads `enabled: true` — the row must
		// not depend on the device having already lowered it.
		const { container } = renderRow(zte, {
			enx344b50000000: { tp: 12, enabled: true, ip: "192.168.0.169" },
		});
		const toggle = container.querySelector('button[role="switch"]');

		expect(toggle?.hasAttribute("disabled")).toBe(true);
	});

	it("shows it as Excluded rather than In Bond", () => {
		const zte = dongle({
			ifname: "enx344b50000000",
			router_admin: {
				admin_url: "http://192.168.0.1",
				reachable: true,
				sim: "absent",
			},
		});
		const { container } = renderRow(zte, {
			enx344b50000000: { tp: 12, enabled: true, ip: "192.168.0.169" },
		});

		// RETARGETED, not weakened. The bond word now RESERVES the width of the
		// state it is not in (both words share one grid cell, the inactive one
		// `invisible`) so this control cannot displace the signal glyph beside it
		// — see `BondToggle`. So `textContent` legitimately holds both words, and
		// the question "what does the operator SEE" moved to the painted child.
		// Asserting that child is strictly stronger than the old substring check:
		// a stray "In Bond" anywhere in the row can no longer satisfy it.
		const slot = container.querySelector<HTMLElement>(
			'[data-testid="bond-state-enx344b50000000"]',
		);
		const painted = Array.from(slot?.children ?? []).filter(
			(child) => !child.className.includes("invisible"),
		);
		expect(painted).toHaveLength(1);
		expect(painted[0]?.textContent).toBe("Excluded");
		expect(painted[0]?.textContent).not.toBe("In Bond");
	});

	// The dongle's SIM verdict is the DEVICE's own word, so an unreachable or
	// unjustifiable reading must never take a working uplink out of the bond.
	it("leaves a dongle whose slot could not be read alone", () => {
		const unknown = dongle({
			router_admin: {
				admin_url: "http://192.168.8.1",
				reachable: false,
				sim: "unknown",
			},
		});
		expect(
			bondDisabledReasonKey(
				unknown,
				"router-ethernet",
				resolveRowState(unknown, "router-ethernet"),
				true,
			),
		).toBeUndefined();
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

		// Both keys make the same claim about where this dongle's settings live;
		// the specific one additionally says why Configure is dead. Exactly one
		// of them may reach the row, and it must be the informative one — the
		// generic sentence beneath it would restate half of what it already says.
		const owningKeys = notes.filter(
			(k) =>
				k === "network.cellular.reason.routerManaged" ||
				k === "network.cellular.reason.routerControlsUnverified",
		);
		expect(owningKeys).toEqual([
			"network.cellular.reason.routerControlsUnverified",
		]);
	});

	/**
	 * The two `router-ethernet` rows an operator is most likely to compare are a
	 * dongle whose writes were proven and one whose were not. They are the same
	 * class, run the same kind of firmware and sit in the same list, so if the
	 * refusal borrows the generic availability sentence the ONLY visible
	 * difference between them is that one button is greyed out — with the row
	 * offering no answer to the obvious "why not this one?".
	 */
	it("tells a verified dongle apart from an unverified one, in words", () => {
		const verified = renderRow(
			dongle({
				ifname: "enx344b50000000",
				router_admin: {
					admin_url: "http://192.168.8.1",
					reachable: true,
					sim: "present",
					controls: { mobile_data: true, roaming_autoconnect: false },
				},
			} as Partial<Modem>),
		);
		const unverified = renderRow(dongle());

		const noteKeys = (root: ParentNode) =>
			[...root.querySelectorAll('[data-testid="modem-note"]')].map((n) =>
				n.getAttribute("data-note-key"),
			);

		expect(noteKeys(verified.container)).not.toContain(
			"network.cellular.reason.routerControlsUnverified",
		);
		expect(noteKeys(unverified.container)).toContain(
			"network.cellular.reason.routerControlsUnverified",
		);

		const configureButton = (root: ParentNode) =>
			root.querySelector<HTMLButtonElement>(
				'[data-testid="open-modem-config-dialog"]',
			);
		expect(configureButton(verified.container)?.disabled).toBe(false);
		expect(configureButton(unverified.container)?.disabled).toBe(true);
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

/**
 * THE LINK-STATE BADGE, RENDERED — "Up" WAS A CLAIM ABOUT THE WHOLE PATH.
 *
 * A `router-ethernet` row can observe exactly one thing about its device: the
 * USB-Ethernet link the dongle presents to the board. Its badge said "Up",
 * drawn in the register the bond is drawn in, so on this bench every SIM-less
 * dongle rendered a green `Up` beside its `No SIM` pill — the operator's own
 * words, "we could have Ethernet connection, but it doesn't mean that we are
 * connected. That kind of collision in consistencies give a really bad UI UX."
 *
 * The row must therefore separate a link that is up from a modem that is
 * carrying, on every channel it has, and must report the link IDENTICALLY
 * whether or not a SIM is present — the SIM is what the pill beside it is for.
 */
describe("the router link badge reports a LINK, not a connection", () => {
	const connectedRadio = (): Modem =>
		({
			ifname: "wwan0",
			name: "RM530N-GL",
			network_type: { supported: [], active: "5G" },
			device_class: "usb",
			status: {
				connection: "connected",
				signal: 78,
				roaming: false,
				network: "Movistar",
				network_type: "5G",
			},
		}) as unknown as Modem;

	const badge = (root: ParentNode, id: string) =>
		root.querySelector<HTMLElement>(
			`[data-modem-id="${id}"] [data-testid="modem-state-badge"]`,
		);

	function renderPair(sim: "absent" | "present") {
		return render(CellularSection, {
			props: {
				modemEntries: [
					[
						"1000",
						dongle({
							router_admin: {
								admin_url: "http://192.168.8.1",
								reachable: true,
								sim,
								connection: "disconnected",
							},
						} as Partial<Modem>),
					],
					["2000", connectedRadio()],
				],
				netif: BENCH_NETIF,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConfigure: vi.fn(),
			},
		});
	}

	it.each(["absent", "present"] as const)(
		"reads differently from a connected radio with a SIM %s",
		(sim) => {
			const { container } = renderPair(sim);
			const link = badge(container, "1000");
			const connected = badge(container, "2000");

			expect(link?.dataset.modemState).toBe("router-up");
			expect(connected?.dataset.modemState).toBe("connected");

			const linkWord = link?.textContent?.trim();
			const connectedWord = connected?.textContent?.trim();
			expect(linkWord).toBeTruthy();
			expect(connectedWord).toBeTruthy();
			expect(linkWord).not.toBe(connectedWord);

			// Colour reinforces the word rather than carrying it, so the two must
			// also differ in register — a bare word swap inside the same green
			// pill leaves the glance-level read unchanged, and the glance is what
			// the operator reported on.
			expect(link?.dataset.statusBadge).toBeTruthy();
			expect(link?.dataset.statusBadge).not.toBe(
				connected?.dataset.statusBadge,
			);
		},
	);

	it("names the LINK rather than claiming a connection", () => {
		const { container } = renderPair("absent");
		const word = badge(container, "1000")?.textContent?.trim() ?? "";

		expect(word).toBe("Link up");
		expect(word.toLowerCase()).not.toContain("connect");
	});

	// The link is a fact about the wire; the SIM is a fact about the radio behind
	// it. Letting the SIM change the link badge is precisely how one pill came to
	// contradict the other, so the two fixtures must produce the same badge and
	// the difference must live in the pill beside it.
	it("reports the same link state whether or not a SIM is present", () => {
		const absent = badge(renderPair("absent").container, "1000");
		const present = badge(renderPair("present").container, "1000");

		expect(absent?.textContent?.trim()).toBe(present?.textContent?.trim());
		expect(absent?.dataset.statusBadge).toBe(present?.dataset.statusBadge);
	});

	it("keeps the No SIM pill as the thing that differs", () => {
		const withoutSim = renderPair("absent").container;
		const withSim = renderPair("present").container;
		const noSimPill = (root: ParentNode) =>
			root.querySelector('[data-modem-id="1000"] [data-no-sim="true"]');

		expect(noSimPill(withoutSim)).not.toBeNull();
		expect(noSimPill(withSim)).toBeNull();
	});
});
