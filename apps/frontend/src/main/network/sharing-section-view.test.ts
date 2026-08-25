/*
 * The Internet-Sharing derivation, driven as pure data.
 *
 * Every payload is first parsed by the SHARED Zod schema, so no case can drift
 * into a shape the device could never send. What matters here is that each
 * honest non-state resolves to a TYPED band rather than to silence or to a
 * spinner, that a machine token never escapes as copy, and that the two
 * zone/reachability bands stay mutually exclusive.
 */

import type {
	NetifEntry,
	NetifMessage,
	SharingDiag,
	UplinkShaperStatus,
	UplinkSteeringStatus,
	UplinksMessage,
} from "@ceraui/rpc/schemas";
import {
	sharingDiagSchema,
	uplinkShaperStatusSchema,
	uplinkSteeringStatusSchema,
	uplinksMessageSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveClientZones,
	derivePriority,
	deriveSharingDiagView,
	deriveSharingSection,
	type HotspotZoneInput,
	SHARING_LINK_TOKENS,
	type SharingSectionInput,
	uplinkReasonKey,
} from "./sharing-section-view";

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

const HOTSPOT_WITH_TWO: HotspotZoneInput = {
	hotspot: {
		name: "CERALIVE_791c",
		available_channels: { auto: { name: "Automatic" } },
		clients: {
			count: 2,
			stations: [{ mac: "8c:85:90:1a:2b:3c" }, { mac: "3c:22:fb:0e:91:7d" }],
		},
	},
};
const HOTSPOT_NO_ROSTER: HotspotZoneInput = {
	hotspot: {
		name: "CERALIVE_791c",
		available_channels: { auto: { name: "Automatic" } },
	},
};

function netif(entries: Record<string, Partial<NetifEntry>>): NetifMessage {
	const out: NetifMessage = {};
	for (const [name, entry] of Object.entries(entries)) {
		out[name] = { tp: 0, enabled: true, ...entry } as NetifEntry;
	}
	return out;
}

function section(
	overrides: Partial<SharingSectionInput> = {},
): ReturnType<typeof deriveSharingSection> {
	return deriveSharingSection({
		uplinks: uplinks({ iface: "wwan0" }),
		diag: undefined,
		steering: undefined,
		shaper: undefined,
		netif: undefined,
		hotspotInterfaces: [HOTSPOT_WITH_TWO],
		now: NOW,
		...overrides,
	});
}

function bandKinds(view: ReturnType<typeof deriveSharingSection>): string[] {
	return view.bands.map((band) => band.kind);
}

describe("per-uplink rows", () => {
	it("resolves state, kind and reason to keyed copy, never a raw token", () => {
		const view = section({
			uplinks: uplinks({
				iface: "wlan0",
				kind: "wifi",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
			}),
		});

		const [row] = view.rows;
		expect(row?.stateLabelKey).toBe("network.sharing.state.degraded");
		expect(row?.kindLabelKey).toBe("network.sharing.kind.wifi");
		expect(row?.reasonKey).toBe("network.sharing.reason.captivePortal");
		// The machine token stays available for a data-attribute, and only there.
		expect(row?.reason).toBe("captive_portal");
		expect(row?.weight).toBe(25);
	});

	it("carries every uplink reason to its own sentence", () => {
		expect(uplinkReasonKey("probe_failed")).toBe(
			"network.sharing.reason.probeFailed",
		);
		expect(uplinkReasonKey("passive_congestion")).toBe(
			"network.sharing.reason.passiveCongestion",
		);
		expect(uplinkReasonKey("definitive_loss")).toBe(
			"network.sharing.reason.definitiveLoss",
		);
		expect(uplinkReasonKey(undefined)).toBeUndefined();
	});

	it("marks a record past its staleAt, and only then", () => {
		const fresh = section({
			uplinks: uplinks({ iface: "wwan0", staleAt: NOW + 1 }),
		});
		expect(fresh.rows[0]?.stale).toBe(false);

		const stale = section({
			uplinks: uplinks({ iface: "wwan0", staleAt: NOW - 1 }),
		});
		expect(stale.rows[0]?.stale).toBe(true);

		// The boundary itself is stale: `staleAt` is the instant the value stops
		// being vouched for, not the last instant it is trusted.
		const boundary = section({
			uplinks: uplinks({ iface: "wwan0", staleAt: NOW }),
		});
		expect(boundary.rows[0]?.stale).toBe(true);
	});

	it("never marks a record the device gave no staleAt for", () => {
		const view = section({ uplinks: uplinks({ iface: "wwan0", staleAt: 0 }) });
		expect(view.rows[0]?.stale).toBe(false);
	});

	it("assigns 1-based spectral tokens and wraps past the ramp's six rungs", () => {
		const many = uplinks(
			...Array.from({ length: 7 }, (_, i) => ({ iface: `ww${i}` })),
		);
		const view = section({ uplinks: many });
		expect(view.rows.map((row) => row.linkIndex)).toEqual([
			1, 2, 3, 4, 5, 6, 1,
		]);
		expect(SHARING_LINK_TOKENS).toBe(6);
	});
});

describe("client zones", () => {
	it("sums the hotspot roster through the SAME rule HotspotSection renders", () => {
		const zones = deriveClientZones([HOTSPOT_WITH_TWO], undefined);
		expect(zones.hotspots).toBe(1);
		expect(zones.hotspotClients).toBe(2);
		expect(zones.active).toBe(true);
	});

	it("leaves the client count UNDEFINED when no AP reported a roster", () => {
		// A measured zero and an unread roster are different facts; inventing
		// "0 clients" asserts a count nobody took.
		const zones = deriveClientZones([HOTSPOT_NO_ROSTER], undefined);
		expect(zones.hotspotClients).toBeUndefined();
		expect(zones.active).toBe(true);
	});

	it("lists a shared-LAN port and reads its zone off the leased address", () => {
		const zones = deriveClientZones(
			[],
			netif({
				eth0: { ethRole: "shared-lan", ip: "10.42.1.1" },
				eth1: { ethRole: "shared-lan" },
				eth2: { ethRole: "uplink", ip: "192.168.0.5" },
			}),
		);
		expect(zones.sharedLan).toEqual([
			{
				ifname: "eth0",
				zone: "serving",
				zoneLabelKey: "network.ethRole.zoneServing",
			},
			{
				ifname: "eth1",
				zone: "starting",
				zoneLabelKey: "network.ethRole.zoneStarting",
			},
		]);
		expect(zones.active).toBe(true);
	});

	it("is inactive with no hotspot and no shared-LAN port", () => {
		const zones = deriveClientZones([], netif({ eth0: { ethRole: "uplink" } }));
		expect(zones.active).toBe(false);
	});
});

describe("streaming priority", () => {
	const shaper = (value: unknown): UplinkShaperStatus =>
		uplinkShaperStatusSchema.parse(value);

	it("reports the adaptive cap only while a stream is live", () => {
		const live = derivePriority(
			shaper({ state: "available", mode: "streaming", algorithm: "cake" }),
		);
		expect(live.kind).toBe("adaptive-cap");
		expect(live.algorithmKey).toBe("network.sharing.priority.algorithmCake");

		const idle = derivePriority(
			shaper({
				state: "available",
				mode: "idle",
				algorithm: "htb-fq_codel",
			}),
		);
		expect(idle.kind).toBe("fair-queue");
		expect(idle.algorithmKey).toBe("network.sharing.priority.algorithmHtb");
	});

	it("says priority-degraded with the device's own typed reason", () => {
		const view = derivePriority(
			shaper({
				state: "shaper_unavailable",
				reason: "foreign_qdisc",
				priorityDegraded: true,
				detail: "root qdisc handle 8001: is not ours",
			}),
		);
		expect(view.kind).toBe("degraded");
		expect(view.reason).toBe("foreign_qdisc");
		expect(view.reasonKey).toBe("network.sharing.priority.reason.foreignQdisc");
	});

	it("reports an absent snapshot as NOT REPORTED, never as available", () => {
		const view = derivePriority(undefined);
		expect(view.kind).toBe("unreported");
		expect(view.labelKey).toBe("network.sharing.priority.unreported");
		expect(view.algorithmKey).toBeUndefined();
	});
});

describe("honest bands", () => {
	it("bands sharing-off when no client zone is active", () => {
		const view = section({ hotspotInterfaces: [], netif: undefined });
		expect(bandKinds(view)).toEqual(["sharing-off"]);
		expect(view.bands[0]?.tone).toBe("info");
	});

	it("bands no-healthy-uplink when sharing is on and every uplink is down", () => {
		const view = section({
			uplinks: uplinks(
				{ iface: "wwan0", state: "down", weight: 0 },
				{ iface: "wwan1", state: "down", weight: 0 },
			),
		});
		expect(bandKinds(view)).toEqual(["no-healthy-uplink"]);
		expect(view.bands[0]?.tone).toBe("warning");
	});

	it("treats a DEGRADED uplink as still usable, so no band fires", () => {
		const view = section({
			uplinks: uplinks({
				iface: "wwan0",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
			}),
		});
		expect(bandKinds(view)).toEqual([]);
	});

	it("bands an empty uplink list exactly like an all-down one", () => {
		const view = section({ uplinks: uplinksMessageSchema.parse([]) });
		expect(bandKinds(view)).toEqual(["no-healthy-uplink"]);
	});

	it("bands an ABSENT snapshot as unreported — never a spinner", () => {
		const view = section({ uplinks: undefined });
		expect(bandKinds(view)).toEqual(["uplinks-unreported"]);
	});

	it("never stacks sharing-off with a reachability band", () => {
		// Sharing being off already explains why nothing is steered; restating it
		// as "no healthy uplink" would announce one fact twice.
		const view = section({
			hotspotInterfaces: [],
			netif: undefined,
			uplinks: uplinks({ iface: "wwan0", state: "down", weight: 0 }),
		});
		expect(bandKinds(view)).toEqual(["sharing-off"]);
	});

	it("bands steering-unavailable with keyed copy for its typed reason", () => {
		const steering: UplinkSteeringStatus = uplinkSteeringStatusSchema.parse({
			state: "steering_unavailable",
			reason: "overlapping_subnet",
			detail: "client zone 10.42.0.0/24 overlaps wwan0",
		});
		const view = section({ steering });
		const band = view.bands.find((b) => b.kind === "steering-unavailable");
		expect(band?.reasonKey).toBe(
			"network.sharing.steeringReason.overlappingSubnet",
		);
		expect(band?.reason).toBe("overlapping_subnet");
	});

	it("keeps steering-unavailable ALONGSIDE a reachability band", () => {
		// They are different facts: one says nothing is being spread, the other
		// says there is nowhere to spread it to.
		const view = section({
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
			uplinks: uplinks({ iface: "wwan0", state: "down", weight: 0 }),
		});
		expect(bandKinds(view)).toEqual([
			"steering-unavailable",
			"no-healthy-uplink",
		]);
	});

	it("renders no steering band while steering is available or unreported", () => {
		expect(
			bandKinds(
				section({
					steering: uplinkSteeringStatusSchema.parse({ state: "available" }),
				}),
			),
		).toEqual([]);
		expect(bandKinds(section({ steering: undefined }))).toEqual([]);
	});
});

describe("coexistence diagnostics", () => {
	const diag = (checks: Partial<SharingDiag>): SharingDiag =>
		sharingDiagSchema.parse({
			state: "degraded",
			checkedAt: NOW,
			firewallBackend: { state: "ok" },
			steeringRules: { state: "ok" },
			sharedNat: { state: "ok" },
			foreignTables: { state: "ok" },
			...checks,
		});

	it("says nothing at all for an absent snapshot or a clean verdict", () => {
		expect(deriveSharingDiagView(undefined)).toBeUndefined();
		expect(deriveSharingDiagView(diag({ state: "ok" }))).toBeUndefined();
	});

	it("ignores an UNKNOWN check — a withheld reading is not a finding", () => {
		expect(
			deriveSharingDiagView(
				diag({ state: "unknown", foreignTables: { state: "unknown" } }),
			),
		).toBeUndefined();
	});

	it("keeps a pre-pin image in the CALM register, not the warning one", () => {
		// Every device in the field reads `unpinned` until the image ships the
		// firewall-backend pin; amber-banding the whole fleet would report the
		// tri-state tolerance working as a fault.
		const view = deriveSharingDiagView(
			diag({
				firewallBackend: {
					state: "degraded",
					reason: "firewall_backend_unpinned",
				},
			}),
		);
		expect(view?.tone).toBe("info");
		expect(view?.findings).toEqual([
			{
				check: "firewallBackend",
				reason: "firewall_backend_unpinned",
				reasonKey: "network.sharing.diag.reason.backendUnpinned",
			},
		]);
	});

	it("escalates real drift to the warning register and keys every reason", () => {
		const view = deriveSharingDiagView(
			diag({
				firewallBackend: {
					state: "degraded",
					reason: "firewall_backend_unpinned",
				},
				steeringRules: {
					state: "degraded",
					reason: "steering_rule_shadows_source_route",
					detail: "steering rules at priority 90 run at or before 100",
				},
			}),
		);
		expect(view?.tone).toBe("warning");
		expect(view?.findings.map((f) => f.reasonKey)).toEqual([
			"network.sharing.diag.reason.backendUnpinned",
			"network.sharing.diag.reason.ruleShadows",
		]);
		expect(view?.findings[1]?.detail).toBe(
			"steering rules at priority 90 run at or before 100",
		);
	});

	it("carries every wire reason to its own sentence", () => {
		const reasons = [
			["firewall_backend_mismatch", "backendMismatch"],
			["steering_rule_priority_drift", "priorityDrift"],
			["shared_nat_missing", "natMissing"],
			["shared_nat_duplicated", "natDuplicated"],
			["foreign_table_modified", "foreignTable"],
		] as const;
		for (const [reason, suffix] of reasons) {
			const view = deriveSharingDiagView(
				diag({ sharedNat: { state: "degraded", reason } }),
			);
			expect(view?.findings[0]?.reasonKey).toBe(
				`network.sharing.diag.reason.${suffix}`,
			);
		}
	});
});
