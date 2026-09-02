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
	deriveDiagnosticsSummary,
	derivePriority,
	deriveSharingDiagView,
	deriveSharingHeadline,
	deriveSharingSection,
	type HotspotZoneInput,
	SHARING_LINK_TOKENS,
	type SharingBand,
	type SharingSectionInput,
	showSteeringShare,
	subordinateBands,
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

describe("the steering share is a share, not a quality score", () => {
	const ZONES_ON = {
		hotspots: 1,
		hotspotClients: 2,
		sharedLan: [],
		active: true,
	};
	const ZONES_OFF = {
		hotspots: 0,
		hotspotClients: undefined,
		sharedLan: [],
		active: false,
	};
	const STEERING_OK = uplinkSteeringStatusSchema.parse({ state: "available" });
	const STEERING_DOWN = uplinkSteeringStatusSchema.parse({
		state: "steering_unavailable",
		reason: "mark_collision",
	});

	it("shows it while client traffic is really being steered", () => {
		expect(showSteeringShare(ZONES_ON, STEERING_OK)).toBe(true);
	});

	it("withholds it when NO client zone exists — there is nothing to share", () => {
		expect(showSteeringShare(ZONES_OFF, STEERING_OK)).toBe(false);
		expect(showSteeringShare(ZONES_OFF, undefined)).toBe(false);
	});

	it("withholds it when the device SAID its steering layer is unavailable", () => {
		// Clients fall back to the default route, so the share steers nothing.
		expect(showSteeringShare(ZONES_ON, STEERING_DOWN)).toBe(false);
	});

	it("an UNREPORTED steering state withholds nothing — absence is not evidence", () => {
		expect(showSteeringShare(ZONES_ON, undefined)).toBe(true);
	});

	it("rides the section view, so a render site never re-derives it", () => {
		expect(section().showSteeringShare).toBe(true);
		expect(section({ hotspotInterfaces: [] }).showSteeringShare).toBe(false);
		expect(section({ steering: STEERING_DOWN }).showSteeringShare).toBe(false);
	});

	it("never touches the row's own weight — only whether it is rendered", () => {
		// The value is the device's record; withholding is a DISPLAY decision.
		const withheld = section({
			hotspotInterfaces: [],
			uplinks: uplinks({ iface: "wwan0", weight: 70 }),
		});
		expect(withheld.showSteeringShare).toBe(false);
		expect(withheld.rows[0]?.weight).toBe(70);
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

describe("the quiet card", () => {
	it("is quiet exactly when no client zone exists", () => {
		expect(section({ hotspotInterfaces: [], netif: undefined }).quiet).toBe(
			true,
		);
		expect(
			section({
				hotspotInterfaces: [],
				netif: netif({ eth0: { ethRole: "uplink", ip: "192.168.0.5" } }),
			}).quiet,
		).toBe(true);
	});

	it("is loud for a hotspot alone, and for a shared-LAN port alone", () => {
		expect(
			section({ hotspotInterfaces: [HOTSPOT_NO_ROSTER], netif: undefined })
				.quiet,
		).toBe(false);
		expect(
			section({
				hotspotInterfaces: [],
				netif: netif({ eth1: { ethRole: "shared-lan" } }),
			}).quiet,
		).toBe(false);
	});

	it("reads the client zones, NOT the headline's precedence", () => {
		// A zone that exists makes the card loud however little else is known —
		// so the verdict has to track `zones.active` rather than whichever band
		// happens to lead.
		const view = section({
			hotspotInterfaces: [],
			netif: netif({ eth0: { ethRole: "shared-lan", ip: "10.42.1.1" } }),
			uplinks: undefined,
		});
		expect(view.headline.kind).toBe("uplinks-unreported");
		expect(view.quiet).toBe(false);
		expect(view.quiet).toBe(!view.zones.active);
	});

	it("still derives every instrument it declines to show", () => {
		// `quiet` gates RENDERING. Truncating the derivation instead would make a
		// zone appearing mid-session a different code path from one present at
		// first paint.
		const view = section({
			hotspotInterfaces: [],
			netif: undefined,
			shaper: uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "streaming",
				algorithm: "cake",
			}),
		});
		expect(view.quiet).toBe(true);
		expect(view.rows).toHaveLength(1);
		expect(view.priority.kind).toBe("adaptive-cap");
		expect(view.headline.kind).toBe("sharing-off");
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

describe("the ONE headline state line", () => {
	it("speaks for the healthy case with the device's own uplink counts", () => {
		const view = section({
			uplinks: uplinks(
				{ iface: "wwan0" },
				{ iface: "wlan0", state: "degraded", weight: 25 },
				{ iface: "eth0", state: "down", weight: 0 },
			),
		});
		expect(view.headline.kind).toBe("sharing-active");
		expect(view.headline.tone).toBe("ok");
		// A degraded uplink still carries traffic, so it counts as usable — the
		// same rule `reachabilityBand` applies when it decides not to fire.
		expect(view.headline.usableUplinks).toBe(2);
		expect(view.headline.totalUplinks).toBe(3);
		expect(view.headline.restatesRowState).toBe(false);
	});

	it("adopts the governing band verbatim, reason included", () => {
		const view = section({
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
		});
		const band = view.bands.find((b) => b.kind === "steering-unavailable");
		expect(view.headline.kind).toBe("steering-unavailable");
		expect(view.headline.tone).toBe(band?.tone);
		expect(view.headline.titleKey).toBe(band?.titleKey);
		expect(view.headline.bodyKey).toBe(band?.bodyKey);
		expect(view.headline.reason).toBe("mark_collision");
		expect(view.headline.reasonKey).toBe(band?.reasonKey);
	});

	it("orders by SCOPE, so a wider fact outranks a narrower one", () => {
		const steering = uplinkSteeringStatusSchema.parse({
			state: "steering_unavailable",
			reason: "mark_collision",
		});

		// Nothing is shared, so how it would be steered is moot.
		expect(
			section({ steering, hotspotInterfaces: [], netif: undefined }).headline
				.kind,
		).toBe("sharing-off");

		// There is nowhere to send client traffic, so a steering failure is not
		// the fact to lead with.
		expect(
			section({
				steering,
				uplinks: uplinks({ iface: "wwan0", state: "down", weight: 0 }),
			}).headline.kind,
		).toBe("no-healthy-uplink");

		// But a refusal the device actually NAMED outranks a report that never
		// arrived — `uplinks-unreported` says nothing definite.
		expect(section({ steering, uplinks: undefined }).headline.kind).toBe(
			"steering-unavailable",
		);
	});

	it("mutes the rows ONLY when it already asserts their state", () => {
		const allDown = section({
			uplinks: uplinks(
				{ iface: "wwan0", state: "down", weight: 0 },
				{ iface: "wwan1", state: "down", weight: 0 },
			),
		});
		expect(allDown.headline.kind).toBe("no-healthy-uplink");
		expect(allDown.headline.restatesRowState).toBe(true);

		// Every other band names something the rows do not restate.
		for (const view of [
			section({ hotspotInterfaces: [], netif: undefined }),
			section({ uplinks: undefined }),
			section({
				steering: uplinkSteeringStatusSchema.parse({
					state: "steering_unavailable",
					reason: "mark_collision",
				}),
			}),
			section(),
		]) {
			expect(view.headline.restatesRowState).toBe(false);
		}
	});

	it("never mutes an EMPTY roster — there is no row to deduplicate", () => {
		const view = section({ uplinks: uplinksMessageSchema.parse([]) });
		expect(view.headline.kind).toBe("no-healthy-uplink");
		expect(view.headline.restatesRowState).toBe(false);
	});

	it("demotes the band it did NOT speak for, and drops nothing", () => {
		const view = section({
			steering: uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
			uplinks: uplinks({ iface: "wwan0", state: "down", weight: 0 }),
		});
		expect(view.headline.kind).toBe("no-healthy-uplink");
		expect(view.subordinate.map((b) => b.kind)).toEqual([
			"steering-unavailable",
		]);
		// Every band is still accounted for: one leads, the rest are demoted.
		expect(
			[view.headline.kind, ...view.subordinate.map((b) => b.kind)].sort(),
		).toEqual(bandKinds(view).slice().sort());
	});

	it("leaves nothing subordinate when one band is the whole story", () => {
		expect(section().subordinate).toEqual([]);
		expect(
			section({ hotspotInterfaces: [], netif: undefined }).subordinate,
		).toEqual([]);
	});
});

describe("the diagnostics disclosure summary", () => {
	const band = (kind: SharingBand["kind"], tone: "info" | "warning") =>
		({ kind, tone, titleKey: "t", bodyKey: "b" }) satisfies SharingBand;

	it("says NOTHING TO REVIEW when every instrument is clean", () => {
		const summary = deriveDiagnosticsSummary(
			derivePriority(
				uplinkShaperStatusSchema.parse({
					state: "available",
					mode: "idle",
					algorithm: "cake",
				}),
			),
			undefined,
			[],
		);
		expect(summary).toEqual({
			tone: "neutral",
			findings: 0,
			labelKey: "network.sharing.diagnostics.clear",
		});
	});

	it("does NOT count an unreported shaper — an honest non-state is not a fault", () => {
		const summary = deriveDiagnosticsSummary(
			derivePriority(undefined),
			undefined,
			[],
		);
		expect(summary.findings).toBe(0);
		expect(summary.tone).toBe("neutral");
	});

	it("keeps a pre-pin verdict in the calm register while it is alone", () => {
		const diag = deriveSharingDiagView(
			sharingDiagSchema.parse({
				state: "degraded",
				checkedAt: NOW,
				firewallBackend: {
					state: "degraded",
					reason: "firewall_backend_unpinned",
				},
				steeringRules: { state: "ok" },
				sharedNat: { state: "ok" },
				foreignTables: { state: "ok" },
			}),
		);
		const summary = deriveDiagnosticsSummary(
			derivePriority(undefined),
			diag,
			[],
		);
		expect(summary.tone).toBe("info");
		expect(summary.findings).toBe(1);
		expect(summary.labelKey).toBe("network.sharing.diagnostics.findingsOne");
	});

	it("escalates to WARNING for anything folded away that is one", () => {
		const degradedShaper = derivePriority(
			uplinkShaperStatusSchema.parse({
				state: "shaper_unavailable",
				reason: "tc_apply_failed",
				priorityDegraded: true,
			}),
		);
		expect(deriveDiagnosticsSummary(degradedShaper, undefined, []).tone).toBe(
			"warning",
		);
		expect(
			deriveDiagnosticsSummary(derivePriority(undefined), undefined, [
				band("steering-unavailable", "warning"),
			]).tone,
		).toBe("warning");
	});

	it("counts every folded finding, so a closed disclosure cannot hide a total", () => {
		const diag = deriveSharingDiagView(
			sharingDiagSchema.parse({
				state: "degraded",
				checkedAt: NOW,
				firewallBackend: {
					state: "degraded",
					reason: "firewall_backend_unpinned",
				},
				steeringRules: {
					state: "degraded",
					reason: "steering_rule_shadows_source_route",
				},
				sharedNat: { state: "ok" },
				foreignTables: { state: "ok" },
			}),
		);
		const summary = deriveDiagnosticsSummary(
			derivePriority(
				uplinkShaperStatusSchema.parse({
					state: "shaper_unavailable",
					reason: "foreign_qdisc",
					priorityDegraded: true,
				}),
			),
			diag,
			[band("steering-unavailable", "warning")],
		);
		expect(summary.findings).toBe(4);
		expect(summary.tone).toBe("warning");
		expect(summary.labelKey).toBe("network.sharing.diagnostics.findingsMany");
	});

	it("is wired into the whole-section view, not left to a render site", () => {
		const view = section({
			shaper: uplinkShaperStatusSchema.parse({
				state: "shaper_unavailable",
				reason: "foreign_qdisc",
				priorityDegraded: true,
			}),
		});
		expect(view.diagnostics).toEqual(
			deriveDiagnosticsSummary(view.priority, view.diag, view.subordinate),
		);
		expect(view.headline).toEqual(deriveSharingHeadline(view.bands, view.rows));
		expect(view.subordinate).toEqual(
			subordinateBands(view.bands, view.headline),
		);
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
