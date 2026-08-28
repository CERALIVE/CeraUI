// @vitest-environment jsdom
/*
 * The Internet-Sharing card, asserted against the RENDERED DOM.
 *
 * Each state here is a CLAIM to an operator, so the tests read what is on
 * screen rather than what the derivation returned: a typed band for every
 * honest non-state, a stale row that visibly stops looking fresh, and — the
 * load-bearing one — NO control anywhere, since every input this card reads is
 * diagnostic by its own backend contract.
 */

import type {
	NetifEntry,
	NetifMessage,
	UplinksMessage,
	WifiInterface,
} from "@ceraui/rpc/schemas";
import {
	sharingDiagSchema,
	uplinkShaperStatusSchema,
	uplinkSteeringStatusSchema,
	uplinksMessageSchema,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import SharingSection from "./SharingSection.svelte";

const NOW = 1_700_000_100_000;

function uplinks(
	...records: Array<Partial<UplinksMessage[number]> & { iface: string }>
): UplinksMessage {
	return uplinksMessageSchema.parse(
		records.map((record) => ({
			kind: "cellular",
			state: "up",
			weight: 100,
			lastTransition: NOW - 60_000,
			staleAt: NOW + 60_000,
			probes: { successes: 12, failures: 0 },
			signals: { activeAt: NOW - 1_000 },
			...record,
		})),
	);
}

function hotspot(clientCount?: number): [string, WifiInterface] {
	return [
		"0",
		{
			ifname: "wlan0",
			conn: "hotspot-uuid",
			hw: "58:02:05:e1:79:1c",
			saved: {},
			mode: "hotspot",
			hotspot: {
				name: "CERALIVE_791c",
				available_channels: { auto: { name: "Automatic" } },
				...(clientCount === undefined
					? {}
					: {
							clients: {
								count: clientCount,
								stations: Array.from({ length: clientCount }, (_, i) => ({
									mac: `8c:85:90:00:00:0${i}`,
								})),
							},
						}),
			},
		},
	];
}

function netif(entries: Record<string, Partial<NetifEntry>>): NetifMessage {
	const out: NetifMessage = {};
	for (const [name, entry] of Object.entries(entries)) {
		out[name] = { tp: 0, enabled: true, ...entry } as NetifEntry;
	}
	return out;
}

type Props = Parameters<typeof render<typeof SharingSection>>[1];

function mount(overrides: Record<string, unknown> = {}) {
	return render(SharingSection, {
		props: {
			uplinks: uplinks({ iface: "wwan0" }),
			diag: undefined,
			steering: undefined,
			shaper: undefined,
			netif: undefined,
			hotspotInterfaces: [hotspot(2)],
			now: NOW,
			...overrides,
		},
	} as unknown as Props);
}

const q = (container: HTMLElement, testid: string): HTMLElement | null =>
	container.querySelector(`[data-testid="${testid}"]`);

/**
 * The `data-testid` of the `<details>` that FOLDS this element away, or
 * `undefined` when it is on screen at rest. A `<summary>` is painted while its
 * own `<details>` is closed, so it does not count as folded — which is exactly
 * the distinction "is this fact still visible?" turns on, and the reason a bare
 * `getByTestId` proves nothing about a disclosure.
 */
function foldedUnder(element: Element): string | undefined {
	let node: Element | null = element;
	let inSummary = false;
	while (node !== null) {
		if (node.tagName === "SUMMARY") inSummary = true;
		else if (node.tagName === "DETAILS") {
			if (!inSummary) return node.getAttribute("data-testid") ?? "<details>";
			inSummary = false;
		}
		node = node.parentElement;
	}
	return undefined;
}

/** Clicks a disclosure's own `<summary>`, the way an operator reaches it. */
async function openDisclosure(
	container: HTMLElement,
	testid: string,
): Promise<HTMLDetailsElement> {
	const details = q(container, testid) as HTMLDetailsElement | null;
	expect(details).not.toBeNull();
	expect(details?.tagName).toBe("DETAILS");
	expect(details?.open).toBe(false);
	const summary = details?.querySelector("summary");
	expect(summary).not.toBeNull();
	await fireEvent.click(summary as HTMLElement);
	expect(details?.open).toBe(true);
	return details as HTMLDetailsElement;
}

describe("SharingSection — honest bands", () => {
	it("bands sharing-off when no client zone is active", () => {
		const { container } = mount({ hotspotInterfaces: [], netif: undefined });
		const band = q(container, "sharing-band-sharing-off");
		expect(band).not.toBeNull();
		expect(band?.getAttribute("data-tone")).toBe("info");
		expect(q(container, "sharing-band-no-healthy-uplink")).toBeNull();
	});

	it("bands no-healthy-uplink when every uplink is down", () => {
		const { container } = mount({
			uplinks: uplinks(
				{ iface: "wwan0", state: "down", weight: 0 },
				{ iface: "wwan1", state: "down", weight: 0 },
			),
		});
		const band = q(container, "sharing-band-no-healthy-uplink");
		expect(band).not.toBeNull();
		expect(band?.getAttribute("data-tone")).toBe("warning");
	});

	it("bands steering-unavailable and names its reason in words", () => {
		const { container } = mount({
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "policy_route_missing",
			}),
		});
		const band = q(container, "sharing-band-steering-unavailable");
		expect(band).not.toBeNull();
		expect(band?.getAttribute("data-reason")).toBe("policy_route_missing");

		const reason = q(container, "sharing-band-reason-steering-unavailable");
		expect(reason?.textContent ?? "").toContain("routing table");
		// A machine token must never reach an operator.
		expect(container.textContent ?? "").not.toContain("policy_route_missing");
	});

	it("bands an ABSENT uplink snapshot rather than rendering a spinner", () => {
		const { container } = mount({ uplinks: undefined });
		expect(q(container, "sharing-band-uplinks-unreported")).not.toBeNull();
		expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
		expect(container.querySelector('[role="progressbar"]')).toBeNull();
	});
});

describe("SharingSection — per-uplink rows", () => {
	it("renders one row per uplink with a state chip and a weight bar", () => {
		const { container } = mount({
			uplinks: uplinks(
				{ iface: "wwan0" },
				{ iface: "wlan0", kind: "wifi", state: "degraded", weight: 25 },
			),
		});

		const first = q(container, "sharing-uplink-wwan0");
		expect(first?.getAttribute("data-state")).toBe("up");
		expect(q(container, "sharing-uplink-state-wwan0")?.textContent).toContain(
			"Up",
		);
		expect(
			q(container, "sharing-uplink-weight-wwan0")?.getAttribute("data-weight"),
		).toBe("100");

		const second = q(container, "sharing-uplink-wlan0");
		expect(second?.getAttribute("data-state")).toBe("degraded");
		expect(
			q(container, "sharing-uplink-weight-wlan0")?.getAttribute("data-weight"),
		).toBe("25");
	});

	it("renders a captive portal as its own sentence on the row it belongs to", () => {
		const { container } = mount({
			uplinks: uplinks({
				iface: "wlan0",
				kind: "wifi",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
			}),
		});
		const row = q(container, "sharing-uplink-wlan0");
		expect(row?.getAttribute("data-reason")).toBe("captive_portal");
		expect(q(container, "sharing-uplink-reason-wlan0")?.textContent).toContain(
			"sign-in portal",
		);
		expect(container.textContent ?? "").not.toContain("captive_portal");
	});

	it("degrades a stale row VISIBLY — never fresh-looking dead data", () => {
		const fresh = mount({
			uplinks: uplinks({ iface: "wwan0", staleAt: NOW + 1 }),
		});
		const freshRow = q(fresh.container, "sharing-uplink-wwan0");
		expect(freshRow?.getAttribute("data-stale")).toBe("false");
		expect(freshRow?.className).not.toContain("opacity-50");
		expect(
			fresh.container.querySelector('[data-stale-interface="wwan0"]'),
		).toBeNull();

		const stale = mount({
			uplinks: uplinks({ iface: "wwan0", staleAt: NOW - 1 }),
		});
		const staleRow = q(stale.container, "sharing-uplink-wwan0");
		expect(staleRow?.getAttribute("data-stale")).toBe("true");
		// Dimmed AND marked in words — colour alone never carries a state.
		expect(staleRow?.className).toContain("opacity-50");
		const marker = stale.container.querySelector(
			'[data-stale-interface="wwan0"]',
		);
		expect(marker).not.toBeNull();
		expect(marker?.textContent ?? "").not.toHaveLength(0);
	});
});

describe("SharingSection — client zones", () => {
	it("reports the hotspot roster count through the shared roster rule", () => {
		const { container } = mount({ hotspotInterfaces: [hotspot(2)] });
		expect(
			q(container, "sharing-zone-hotspot-clients")?.textContent ?? "",
		).toContain("2");
	});

	it("says the roster is UNREPORTED rather than inventing a zero", () => {
		const { container } = mount({ hotspotInterfaces: [hotspot(undefined)] });
		const cell = q(container, "sharing-zone-hotspot-clients");
		expect(cell?.textContent ?? "").not.toContain("0");
		expect(cell?.textContent ?? "").toContain("not reported");
	});

	it("lists a shared-LAN port with its zone state", () => {
		const { container } = mount({
			hotspotInterfaces: [],
			netif: netif({ eth0: { ethRole: "shared-lan", ip: "10.42.1.1" } }),
		});
		const zone = q(container, "sharing-zone-shared-lan-eth0");
		expect(zone?.getAttribute("data-zone")).toBe("serving");
		expect(zone?.textContent ?? "").toContain("eth0");
		expect(q(container, "sharing-band-sharing-off")).toBeNull();
	});
});

describe("SharingSection — streaming priority", () => {
	it("reports the adaptive cap and the realized algorithm while streaming", () => {
		const { container } = mount({
			shaper: uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "streaming",
				algorithm: "cake",
			}),
		});
		expect(
			q(container, "sharing-priority")?.getAttribute("data-priority"),
		).toBe("adaptive-cap");
		expect(q(container, "sharing-priority-algorithm")?.textContent).toContain(
			"CAKE",
		);
	});

	it("reports priority-degraded with the device's own typed reason in words", () => {
		const { container } = mount({
			shaper: uplinkShaperStatusSchema.parse({
				state: "shaper_unavailable",
				reason: "foreign_qdisc",
				priorityDegraded: true,
			}),
		});
		const panel = q(container, "sharing-priority");
		expect(panel?.getAttribute("data-priority")).toBe("degraded");
		expect(panel?.getAttribute("data-reason")).toBe("foreign_qdisc");
		expect(q(container, "sharing-priority-reason")?.textContent).toContain(
			"traffic-shaping policy",
		);
		expect(container.textContent ?? "").not.toContain("foreign_qdisc");
	});

	it("reports an absent shaper snapshot as NOT REPORTED", () => {
		const { container } = mount({ shaper: undefined });
		expect(
			q(container, "sharing-priority")?.getAttribute("data-priority"),
		).toBe("unreported");
		expect(q(container, "sharing-priority-algorithm")).toBeNull();
	});
});

describe("SharingSection — coexistence diagnostics", () => {
	const diag = (checks: Record<string, unknown>) =>
		sharingDiagSchema.parse({
			state: "degraded",
			checkedAt: NOW,
			firewallBackend: { state: "ok" },
			steeringRules: { state: "ok" },
			sharedNat: { state: "ok" },
			foreignTables: { state: "ok" },
			...checks,
		});

	it("renders nothing at all for a clean or absent verdict", () => {
		expect(q(mount({ diag: undefined }).container, "sharing-diag")).toBeNull();
		expect(
			q(mount({ diag: diag({ state: "ok" }) }).container, "sharing-diag"),
		).toBeNull();
	});

	it("keeps a pre-pin image calm, and escalates real drift", () => {
		const calm = mount({
			diag: diag({
				firewallBackend: {
					state: "degraded",
					reason: "firewall_backend_unpinned",
				},
			}),
		});
		expect(q(calm.container, "sharing-diag")?.getAttribute("data-tone")).toBe(
			"info",
		);

		const drift = mount({
			diag: diag({
				steeringRules: {
					state: "degraded",
					reason: "steering_rule_shadows_source_route",
				},
			}),
		});
		expect(q(drift.container, "sharing-diag")?.getAttribute("data-tone")).toBe(
			"warning",
		);
		expect(
			q(drift.container, "sharing-diag-steeringRules")?.getAttribute(
				"data-reason",
			),
		).toBe("steering_rule_shadows_source_route");
		expect(drift.container.textContent ?? "").not.toContain(
			"steering_rule_shadows_source_route",
		);
	});
});

describe("SharingSection — ONE state authority", () => {
	const ALL_DOWN = {
		uplinks: uplinks(
			{ iface: "wwan0", state: "down", weight: 0, reason: "definitive_loss" },
			{ iface: "wwan1", state: "down", weight: 0 },
		),
	};

	it("renders the no-healthy-uplink fact ONCE prominently", () => {
		const { container } = mount(ALL_DOWN);

		const headlines = container.querySelectorAll('[data-headline="true"]');
		expect(headlines).toHaveLength(1);
		expect(headlines[0]?.getAttribute("data-kind")).toBe("no-healthy-uplink");
		expect(headlines[0]?.getAttribute("data-testid")).toBe(
			"sharing-band-no-healthy-uplink",
		);

		// "Prominently" means the alarm register, and there is exactly ONE of it
		// on screen: the two rows that would each restate it are muted, so the
		// card raises one alarm rather than three.
		const alarms = [
			...container.querySelectorAll('[data-tone="warning"]'),
			...container.querySelectorAll('[data-status-badge="error"]'),
		].filter((el) => foldedUnder(el) === undefined);
		expect(alarms).toHaveLength(1);
		expect(alarms[0]).toBe(headlines[0]);
	});

	it("mutes the rows WITHOUT dropping their word — colour is reinforcement", () => {
		const { container } = mount(ALL_DOWN);
		for (const iface of ["wwan0", "wwan1"]) {
			const chip = q(container, `sharing-uplink-state-${iface}`);
			expect(chip?.getAttribute("data-muted")).toBe("true");
			expect(chip?.getAttribute("data-status-badge")).toBe("neutral");
			// The state is still SAID, and it is still on screen at rest.
			expect(chip?.textContent ?? "").toContain("Down");
			expect(foldedUnder(chip as Element)).toBeUndefined();
		}
	});

	it("does NOT mute a row the headline never spoke for", () => {
		const { container } = mount({
			uplinks: uplinks(
				{ iface: "wwan0" },
				{ iface: "wlan0", kind: "wifi", state: "down", weight: 0 },
			),
		});
		expect(
			q(container, "sharing-band-sharing-active")?.getAttribute("data-kind"),
		).toBe("sharing-active");
		const chip = q(container, "sharing-uplink-state-wlan0");
		expect(chip?.hasAttribute("data-muted")).toBe(false);
		expect(chip?.getAttribute("data-status-badge")).toBe("error");
	});

	it("leads with the healthy headline and the device's own uplink counts", () => {
		const { container } = mount({
			uplinks: uplinks(
				{ iface: "wwan0" },
				{ iface: "wlan0", kind: "wifi", state: "degraded", weight: 25 },
				{ iface: "eth0", kind: "ethernet", state: "down", weight: 0 },
			),
		});
		const headline = q(container, "sharing-band-sharing-active");
		expect(headline?.getAttribute("data-tone")).toBe("ok");
		expect(headline?.textContent ?? "").toContain("2 of 3");
	});

	it("demotes the band it did not lead with instead of stacking it", async () => {
		const { container } = mount({
			...ALL_DOWN,
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
		});

		// Both facts are still rendered — one leads, the other is folded away.
		const headline = q(container, "sharing-band-no-healthy-uplink");
		const demoted = q(container, "sharing-band-steering-unavailable");
		expect(headline?.getAttribute("data-headline")).toBe("true");
		expect(demoted?.hasAttribute("data-headline")).toBe(false);
		expect(foldedUnder(headline as Element)).toBeUndefined();
		expect(foldedUnder(demoted as Element)).toBe("sharing-diagnostics");

		await openDisclosure(container, "sharing-diagnostics");
		expect(
			q(container, "sharing-band-reason-steering-unavailable")?.textContent ??
				"",
		).toContain("traffic marker");
	});
});

describe("SharingSection — the disclosures", () => {
	const DEGRADED = {
		uplinks: uplinks(
			{ iface: "wwan0", state: "down", weight: 0 },
			{ iface: "wwan1", state: "down", weight: 0 },
		),
		shaper: uplinkShaperStatusSchema.parse({
			state: "shaper_unavailable",
			reason: "foreign_qdisc",
			priorityDegraded: true,
		}),
		diag: sharingDiagSchema.parse({
			state: "degraded",
			checkedAt: NOW,
			firewallBackend: { state: "ok" },
			steeringRules: {
				state: "degraded",
				reason: "steering_rule_shadows_source_route",
			},
			sharedNat: { state: "ok" },
			foreignTables: { state: "ok" },
		}),
	};

	it("folds the instruments away by default and states their tone while closed", () => {
		const { container } = mount(DEGRADED);
		const details = q(container, "sharing-diagnostics") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(details.getAttribute("data-tone")).toBe("warning");
		expect(details.getAttribute("data-findings")).toBe("2");

		// A folded warning that cannot say so is a hidden warning: the chip rides
		// the SUMMARY, so it is painted while the disclosure is shut.
		const chip = q(container, "sharing-diagnostics-chip");
		expect(foldedUnder(chip as Element)).toBeUndefined();
		expect(chip?.getAttribute("data-status-badge")).toBe("warning");
		expect(chip?.textContent ?? "").toContain("2");

		for (const testid of [
			"sharing-priority",
			"sharing-diag",
			"sharing-dns-note",
		]) {
			expect(foldedUnder(q(container, testid) as Element)).toBe(
				"sharing-diagnostics",
			);
		}
	});

	it("stays calm and states it when there is nothing to review", () => {
		const { container } = mount({
			shaper: uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "idle",
				algorithm: "cake",
			}),
		});
		const details = q(container, "sharing-diagnostics") as HTMLDetailsElement;
		expect(details.getAttribute("data-tone")).toBe("neutral");
		expect(details.getAttribute("data-findings")).toBe("0");
		const chip = q(container, "sharing-diagnostics-chip");
		expect(chip?.getAttribute("data-status-badge")).toBe("neutral");
		expect(chip?.textContent ?? "").toContain("Nothing to review");
	});

	it("opens on a real summary click, so the instruments stay reachable", async () => {
		const { container } = mount(DEGRADED);
		await openDisclosure(container, "sharing-diagnostics");
		expect(
			q(container, "sharing-priority-reason")?.textContent ?? "",
		).toContain("traffic-shaping policy");
		expect(q(container, "sharing-diag-steeringRules")).not.toBeNull();
		expect(q(container, "sharing-dns-note")?.textContent ?? "").toContain(
			"default route",
		);
	});

	it("compacts an uplink row to name · kind · state · share", () => {
		const { container } = mount({
			uplinks: uplinks({
				iface: "wlan0",
				kind: "wifi",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
			}),
		});

		// What stays on the row at rest.
		for (const testid of [
			"sharing-uplink-state-wlan0",
			"sharing-uplink-weight-wlan0",
		]) {
			expect(foldedUnder(q(container, testid) as Element)).toBeUndefined();
		}
		// What the row hands to its own disclosure.
		for (const testid of [
			"sharing-uplink-probes-wlan0",
			"sharing-uplink-reason-wlan0",
		]) {
			expect(foldedUnder(q(container, testid) as Element)).toBe(
				"sharing-uplink-detail-wlan0",
			);
		}
	});

	it("opens ONE row's detail without opening its neighbour's", async () => {
		const { container } = mount({
			uplinks: uplinks({ iface: "wwan0" }, { iface: "wwan1" }),
		});
		await openDisclosure(container, "sharing-uplink-detail-wwan0");
		expect(
			(q(container, "sharing-uplink-detail-wwan1") as HTMLDetailsElement).open,
		).toBe(false);
		expect(
			q(container, "sharing-uplink-probes-wwan0")?.textContent ?? "",
		).toContain("12");
	});
});

/*
 * THE FAILURE MODE THIS RESTRUCTURE COULD HAVE HAD: a fact that used to be on
 * screen quietly leaving the card with the block that carried it. So the wire
 * fields the card has ever rendered are enumerated here by hand, each with a
 * state that makes it render and a value derived from it, and each is asserted
 * REACHABLE — on the surface at rest, or behind a disclosure that genuinely
 * opens on a `<summary>` click.
 *
 * `lastTransition` and `signals.*` are deliberately absent: no version of this
 * card has ever rendered them, so listing them would assert a feature rather
 * than protect one.
 */
describe("SharingSection — wire-field inventory", () => {
	interface FieldProbe {
		readonly field: string;
		readonly props: Record<string, unknown>;
		readonly selector: string;
		readonly contains: string;
	}

	const STEERING = uplinkSteeringStatusSchema.parse({
		state: "steering_unavailable",
		reason: "mark_collision",
	});
	const SHAPER_DEGRADED = uplinkShaperStatusSchema.parse({
		state: "shaper_unavailable",
		reason: "foreign_qdisc",
		priorityDegraded: true,
	});
	const SHAPER_STREAMING = uplinkShaperStatusSchema.parse({
		state: "available",
		mode: "streaming",
		algorithm: "cake",
	});
	const DIAG_ALL = sharingDiagSchema.parse({
		state: "degraded",
		checkedAt: NOW,
		firewallBackend: {
			state: "degraded",
			reason: "firewall_backend_mismatch",
		},
		steeringRules: {
			state: "degraded",
			reason: "steering_rule_priority_drift",
		},
		sharedNat: { state: "degraded", reason: "shared_nat_missing" },
		foreignTables: { state: "degraded", reason: "foreign_table_modified" },
	});
	const ROWS = {
		uplinks: uplinks(
			{
				iface: "wwan0",
				kind: "cellular",
				state: "up",
				weight: 70,
				probes: { successes: 31, failures: 2 },
			},
			{
				iface: "wlan0",
				kind: "wifi",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
				staleAt: NOW - 1,
				probes: { successes: 8, failures: 5 },
			},
		),
	};

	const PROBES: readonly FieldProbe[] = [
		{
			field: "uplinks[].iface",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-wwan0"]',
			contains: "wwan0",
		},
		{
			field: "uplinks[].kind",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-wwan0"]',
			contains: "Cellular",
		},
		{
			field: "uplinks[].state",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-state-wwan0"]',
			contains: "Up",
		},
		{
			field: "uplinks[].reason",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-reason-wlan0"]',
			contains: "sign-in portal",
		},
		{
			field: "uplinks[].weight",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-weight-wwan0"]',
			contains: "70%",
		},
		{
			field: "uplinks[].probes",
			props: ROWS,
			selector: '[data-testid="sharing-uplink-probes-wwan0"]',
			contains: "31 ok · 2 failed",
		},
		{
			field: "uplinks[].staleAt",
			props: ROWS,
			selector: '[data-stale-interface="wlan0"]',
			contains: "Stale",
		},
		{
			field: "sharing_diag.firewallBackend",
			props: { diag: DIAG_ALL },
			selector: '[data-testid="sharing-diag-firewallBackend"]',
			contains: "not the expected one",
		},
		{
			field: "sharing_diag.steeringRules",
			props: { diag: DIAG_ALL },
			selector: '[data-testid="sharing-diag-steeringRules"]',
			contains: "expected priority",
		},
		{
			field: "sharing_diag.sharedNat",
			props: { diag: DIAG_ALL },
			selector: '[data-testid="sharing-diag-sharedNat"]',
			contains: "no address translation",
		},
		{
			field: "sharing_diag.foreignTables",
			props: { diag: DIAG_ALL },
			selector: '[data-testid="sharing-diag-foreignTables"]',
			contains: "firewall table has changed",
		},
		{
			field: "uplink-steering.state",
			props: { steering: STEERING },
			selector: '[data-testid="sharing-band-steering-unavailable"]',
			contains: "Client steering unavailable",
		},
		{
			field: "uplink-steering.reason",
			props: { steering: STEERING },
			selector: '[data-testid="sharing-band-reason-steering-unavailable"]',
			contains: "traffic marker",
		},
		{
			field: "uplink-shaper.state",
			props: { shaper: SHAPER_DEGRADED },
			selector: '[data-testid="sharing-priority-state"]',
			contains: "Priority shaping unavailable",
		},
		{
			field: "uplink-shaper.reason",
			props: { shaper: SHAPER_DEGRADED },
			selector: '[data-testid="sharing-priority-reason"]',
			contains: "traffic-shaping policy",
		},
		{
			field: "uplink-shaper.mode",
			props: { shaper: SHAPER_STREAMING },
			selector: '[data-testid="sharing-priority-state"]',
			contains: "Adaptive cap active",
		},
		{
			field: "uplink-shaper.algorithm",
			props: { shaper: SHAPER_STREAMING },
			selector: '[data-testid="sharing-priority-algorithm"]',
			contains: "CAKE",
		},
		{
			field: "netif[].ethRole",
			props: {
				hotspotInterfaces: [],
				netif: netif({ eth0: { ethRole: "shared-lan", ip: "10.42.1.1" } }),
			},
			selector: '[data-testid="sharing-zone-shared-lan-eth0"]',
			contains: "Shared LAN",
		},
		{
			field: "netif[].ip",
			props: {
				hotspotInterfaces: [],
				netif: netif({ eth0: { ethRole: "shared-lan", ip: "10.42.1.1" } }),
			},
			selector: '[data-testid="sharing-zone-shared-lan-eth0"]',
			contains: "Serving clients",
		},
		{
			field: "hotspot.clients.count",
			props: { hotspotInterfaces: [hotspot(2)] },
			selector: '[data-testid="sharing-zone-hotspot-clients"]',
			contains: "2 devices connected",
		},
		{
			field: "(static) DNS limitation",
			props: {},
			selector: '[data-testid="sharing-dns-note"]',
			contains: "default route",
		},
	];

	for (const probe of PROBES) {
		it(`${probe.field} is still reachable`, async () => {
			const { container } = mount(probe.props);
			const node = container.querySelector(probe.selector);
			expect(node, `${probe.field}: nothing rendered it`).not.toBeNull();
			expect(node?.textContent ?? "").toContain(probe.contains);

			const folded = foldedUnder(node as Element);
			if (folded === undefined) return;

			// Behind a disclosure is reachable only if the disclosure OPENS: a
			// collapsed <details> still answers a testid query, so presence alone
			// would prove nothing.
			const details = await openDisclosure(container, folded);
			const reopened = container.querySelector(probe.selector);
			expect(reopened).not.toBeNull();
			expect(reopened?.textContent ?? "").toContain(probe.contains);
			expect(details.contains(reopened as Node)).toBe(true);
		});
	}

	it("enumerates every field the derivation can key to copy", () => {
		// Non-vacuity: the table is not a stub, and it covers all four wire
		// inputs plus the static note.
		const covered = new Set(PROBES.map((p) => p.field.split(/[.[]/)[0]));
		expect(covered).toEqual(
			new Set([
				"uplinks",
				"sharing_diag",
				"uplink-steering",
				"uplink-shaper",
				"netif",
				"hotspot",
				"(static) DNS limitation",
			]),
		);
	});
});

describe("SharingSection — the surface's own guarantees", () => {
	it("always states the known DNS limitation, whatever the wire says", () => {
		for (const props of [
			{},
			{ uplinks: undefined, hotspotInterfaces: [] },
			{
				steering: uplinkSteeringStatusSchema.parse({
					state: "steering_unavailable",
					reason: "mark_collision",
				}),
			},
		]) {
			const { container } = mount(props);
			expect(q(container, "sharing-dns-note")?.textContent ?? "").toContain(
				"default route",
			);
		}
	});

	it("carries ZERO controls — every input it renders is diagnostic only", () => {
		// The strongest form of "nothing here gates anything": there is no
		// affordance to gate WITH. Asserted against the rendered DOM, because
		// absence has no syntax to grep for.
		const { container } = mount({
			uplinks: uplinks({ iface: "wwan0", state: "down", weight: 0 }),
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
			shaper: uplinkShaperStatusSchema.parse({
				state: "shaper_unavailable",
				reason: "tc_apply_failed",
				priorityDegraded: true,
			}),
			netif: netif({ eth0: { ethRole: "shared-lan", ip: "10.42.1.1" } }),
		});

		expect(container.querySelectorAll("button")).toHaveLength(0);
		expect(container.querySelectorAll("input")).toHaveLength(0);
		expect(container.querySelectorAll("select")).toHaveLength(0);
		expect(container.querySelectorAll("a[href]")).toHaveLength(0);
		expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
		expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
		// Non-vacuity: the section really did render its degraded content.
		expect(q(container, "sharing-band-no-healthy-uplink")).not.toBeNull();
		expect(q(container, "sharing-priority-reason")).not.toBeNull();
	});

	it("renders no dotted i18n key anywhere, in any state", () => {
		const { container } = mount({
			uplinks: uplinks({
				iface: "wwan0",
				state: "degraded",
				reason: "passive_congestion",
				weight: 25,
			}),
			diag: sharingDiagSchema.parse({
				state: "degraded",
				checkedAt: NOW,
				firewallBackend: { state: "ok" },
				steeringRules: { state: "ok" },
				sharedNat: { state: "degraded", reason: "shared_nat_duplicated" },
				foreignTables: { state: "ok" },
			}),
			shaper: uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "idle",
				algorithm: "htb-fq_codel",
			}),
		});
		expect(container.textContent ?? "").not.toMatch(/network\.sharing\./);
		expect(container.textContent ?? "").not.toMatch(/network\.ethRole\./);
	});
});
