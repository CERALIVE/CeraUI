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
import { render } from "@testing-library/svelte";
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
