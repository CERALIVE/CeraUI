/*
 * THE WIRE-CONTRACT MATRIX for the Internet-Sharing surface (todo 13).
 *
 * Four inputs reach that surface, and each one crosses a seam a producer-only
 * test cannot see: `subscriptions.svelte.ts` registers ONE `onMessage` consumer
 * whose switch silently DROPS an unregistered topic, and its `case "netif"`
 * rebuilds every entry from an explicit per-field allowlist that silently drops
 * an unlisted field. A schema, an event and a rendered consumer can therefore
 * all be in place while nothing arrives.
 *
 * So every case below drives the REAL handler, and every payload is first
 * parsed by the SHARED Zod schema so it cannot drift into a shape the device
 * could never send.
 *
 * The one-shot half is the inverse assertion: `uplink-flows-reset` describes a
 * hard-down drain that ALREADY HAPPENED, so it must own no persisted slot, must
 * be handled exactly once, and must survive neither a reset nor a reconnect.
 * The post-login-snapshot half of that proof is the backend's
 * `sharing-surface-initial-push.test.ts`.
 */
import {
	netifMessageSchema,
	sharingDiagSchema,
	uplinkFlowsResetEventSchema,
	uplinkShaperStatusSchema,
	uplinkSteeringStatusSchema,
	uplinksMessageSchema,
} from "@ceraui/rpc/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

let messageHandler:
	| ((type: string, data: unknown, seq?: number) => void)
	| undefined;

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (
			handler: (type: string, data: unknown, seq?: number) => void,
		) => {
			messageHandler = handler;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getNetif,
	getSharingDiag,
	getUplinkShaper,
	getUplinkSteering,
	getUplinks,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import {
	clearNotifications,
	getActive,
} from "$lib/stores/notifications.svelte";
import { deriveSharingSection } from "../main/network/sharing-section-view";

const NOW = 1_700_000_100_000;

const HEALTHY_UPLINKS = uplinksMessageSchema.parse([
	{
		iface: "wwan0",
		kind: "cellular",
		state: "up",
		weight: 100,
		lastTransition: NOW - 90_000,
		staleAt: NOW + 60_000,
		probes: { successes: 30, failures: 0 },
		signals: { activeAt: NOW - 2_000 },
	},
	{
		iface: "wlan0",
		kind: "wifi",
		state: "degraded",
		reason: "captive_portal",
		weight: 25,
		lastTransition: NOW - 30_000,
		staleAt: NOW + 60_000,
		probes: { successes: 8, failures: 3 },
		signals: { activeAt: NOW - 4_000 },
	},
]);

const ALL_DOWN = uplinksMessageSchema.parse([
	{
		iface: "wwan0",
		kind: "cellular",
		state: "down",
		reason: "definitive_loss",
		weight: 0,
		lastTransition: NOW - 5_000,
		staleAt: NOW + 60_000,
		probes: { successes: 0, failures: 9 },
		signals: {},
	},
]);

const DIAG_OK = sharingDiagSchema.parse({
	state: "ok",
	checkedAt: NOW,
	firewallBackend: { state: "ok" },
	steeringRules: { state: "ok" },
	sharedNat: { state: "ok" },
	foreignTables: { state: "ok" },
});

const DIAG_DEGRADED = sharingDiagSchema.parse({
	state: "degraded",
	checkedAt: NOW + 30_000,
	firewallBackend: { state: "ok" },
	steeringRules: {
		state: "degraded",
		reason: "steering_rule_shadows_source_route",
		detail: "steering rules at priority 90 run at or before source routing",
	},
	sharedNat: { state: "ok" },
	foreignTables: { state: "unknown" },
});

const FLOWS_RESET = uplinkFlowsResetEventSchema.parse({
	iface: "wwan1",
	linkId: "lnk_9f3c11a0b2d47e58",
});

const SHARED_LAN_NETIF = netifMessageSchema.parse({
	eth0: { tp: 0, enabled: false, ip: "10.42.1.1", ethRole: "shared-lan" },
	eth1: { tp: 0, enabled: true, ip: "192.168.0.5", ethRole: "uplink" },
});

const UPLINK_ONLY_NETIF = netifMessageSchema.parse({
	eth0: { tp: 0, enabled: true, ip: "192.168.0.9", ethRole: "uplink" },
	eth1: { tp: 0, enabled: true, ip: "192.168.0.5", ethRole: "uplink" },
});

/** The rendered consumer, fed from the live store exactly as the section does. */
function renderedSection() {
	return deriveSharingSection({
		uplinks: getUplinks(),
		diag: getSharingDiag(),
		steering: getUplinkSteering(),
		shaper: getUplinkShaper(),
		netif: getNetif(),
		hotspotInterfaces: [],
		now: NOW,
	});
}

function flowsResetNotices() {
	return getActive().filter((n) => n.name.startsWith("uplink-flows-reset:"));
}

beforeEach(() => {
	resetState();
	clearNotifications();
	initSubscriptions();
});

describe("uplinks — the per-uplink health broadcast", () => {
	it("round-trips through the shared schema", () => {
		expect(uplinksMessageSchema.safeParse(HEALTHY_UPLINKS).success).toBe(true);
		// A record the device could never send is refused, so a fixture cannot
		// quietly certify a shape that does not exist.
		expect(
			uplinksMessageSchema.safeParse([{ iface: "wwan0", kind: "satellite" }])
				.success,
		).toBe(false);
	});

	it("reaches rendered state through the REAL subscription handler", () => {
		expect(getUplinks()).toBeUndefined();
		messageHandler?.("uplinks", HEALTHY_UPLINKS);

		const view = renderedSection();
		expect(view.rows.map((row) => row.iface)).toEqual(["wwan0", "wlan0"]);
		expect(view.rows[1]?.reasonKey).toBe(
			"network.sharing.reason.captivePortal",
		);
	});

	it("REPLACES the list wholesale, so a retired uplink leaves the surface", () => {
		messageHandler?.("uplinks", HEALTHY_UPLINKS);
		messageHandler?.("uplinks", ALL_DOWN);

		expect(getUplinks()?.map((r) => r.iface)).toEqual(["wwan0"]);
		expect(renderedSection().rows).toHaveLength(1);
	});

	it("is cleared by resetState, so a logout leaves no stale health", () => {
		messageHandler?.("uplinks", HEALTHY_UPLINKS);
		resetState();
		expect(getUplinks()).toBeUndefined();
	});
});

describe("sharing_diag — the coexistence verdict", () => {
	it("round-trips through the shared schema", () => {
		expect(sharingDiagSchema.safeParse(DIAG_DEGRADED).success).toBe(true);
		expect(
			sharingDiagSchema.safeParse({ ...DIAG_OK, steeringRules: undefined })
				.success,
		).toBe(false);
	});

	it("reaches the rendered consumer with its typed reason", () => {
		messageHandler?.("sharing_diag", DIAG_DEGRADED);

		const view = renderedSection();
		expect(view.diag?.tone).toBe("warning");
		expect(view.diag?.findings[0]?.reasonKey).toBe(
			"network.sharing.diag.reason.ruleShadows",
		);
	});

	it("RETRACTS: a check going back to ok clears the band", () => {
		messageHandler?.("sharing_diag", DIAG_DEGRADED);
		expect(renderedSection().diag).toBeDefined();

		messageHandler?.("sharing_diag", DIAG_OK);
		expect(renderedSection().diag).toBeUndefined();
	});
});

describe("uplink-steering + uplink-shaper — the two new persistent states", () => {
	it("round-trip through the shared schemas", () => {
		expect(
			uplinkSteeringStatusSchema.safeParse({
				state: "steering_unavailable",
				reason: "policy_route_missing",
			}).success,
		).toBe(true);
		expect(
			uplinkShaperStatusSchema.safeParse({
				state: "shaper_unavailable",
				reason: "foreign_qdisc",
				priorityDegraded: true,
			}).success,
		).toBe(true);
		// `priorityDegraded` is a literal `true`, so an unavailable shaper can
		// never be published as un-degraded.
		expect(
			uplinkShaperStatusSchema.safeParse({
				state: "shaper_unavailable",
				reason: "foreign_qdisc",
				priorityDegraded: false,
			}).success,
		).toBe(false);
	});

	it("both reach the rendered consumer through the REAL handler", () => {
		expect(getUplinkSteering()).toBeUndefined();
		expect(getUplinkShaper()).toBeUndefined();
		expect(renderedSection().priority.kind).toBe("unreported");

		messageHandler?.(
			"uplink-steering",
			uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "ruleset_reload_failed",
				detail: "systemctl reload ceralive-share.service exited 1",
			}),
		);
		messageHandler?.(
			"uplink-shaper",
			uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "streaming",
				algorithm: "cake",
			}),
		);

		const view = renderedSection();
		expect(
			view.bands.find((b) => b.kind === "steering-unavailable")?.reasonKey,
		).toBe("network.sharing.steeringReason.reloadFailed");
		expect(view.priority.kind).toBe("adaptive-cap");
	});

	it("RETRACT: recovery clears the band and lifts the priority state", () => {
		messageHandler?.(
			"uplink-steering",
			uplinkSteeringStatusSchema.parse({
				state: "steering_unavailable",
				reason: "mark_collision",
			}),
		);
		messageHandler?.(
			"uplink-shaper",
			uplinkShaperStatusSchema.parse({
				state: "shaper_unavailable",
				reason: "tc_apply_failed",
				priorityDegraded: true,
			}),
		);
		expect(renderedSection().priority.kind).toBe("degraded");

		messageHandler?.(
			"uplink-steering",
			uplinkSteeringStatusSchema.parse({ state: "available" }),
		);
		messageHandler?.(
			"uplink-shaper",
			uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "idle",
				algorithm: "htb-fq_codel",
			}),
		);

		const view = renderedSection();
		expect(view.bands.some((b) => b.kind === "steering-unavailable")).toBe(
			false,
		);
		expect(view.priority.kind).toBe("fair-queue");
	});

	it("both are cleared by resetState", () => {
		messageHandler?.(
			"uplink-steering",
			uplinkSteeringStatusSchema.parse({ state: "available" }),
		);
		messageHandler?.(
			"uplink-shaper",
			uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "idle",
				algorithm: "cake",
			}),
		);
		resetState();
		expect(getUplinkSteering()).toBeUndefined();
		expect(getUplinkShaper()).toBeUndefined();
	});
});

describe("netif ethRole — the shared-LAN client zone", () => {
	it("round-trips through the shared schema", () => {
		expect(netifMessageSchema.safeParse(SHARED_LAN_NETIF).success).toBe(true);
		expect(
			netifMessageSchema.safeParse({
				eth0: { tp: 0, enabled: true, ethRole: "router" },
			}).success,
		).toBe(false);
	});

	it("survives the per-field allowlist and reaches the zone summary", () => {
		messageHandler?.("netif", SHARED_LAN_NETIF);

		expect(getNetif()?.eth0?.ethRole).toBe("shared-lan");
		const view = renderedSection();
		expect(view.zones.sharedLan).toEqual([
			{
				ifname: "eth0",
				zone: "serving",
				zoneLabelKey: "network.ethRole.zoneServing",
			},
		]);
		expect(view.zones.active).toBe(true);
	});

	it("RETRACTS: flipping back to uplink removes the zone", () => {
		// The producer states the role in BOTH directions, which is what makes
		// the ordinary spread-when-present merge carry the retraction.
		messageHandler?.("netif", SHARED_LAN_NETIF);
		messageHandler?.("netif", UPLINK_ONLY_NETIF);

		expect(getNetif()?.eth0?.ethRole).toBe("uplink");
		const view = renderedSection();
		expect(view.zones.sharedLan).toEqual([]);
		expect(view.zones.active).toBe(false);
		expect(view.bands.map((b) => b.kind)).toContain("sharing-off");
	});
});

describe("uplink-flows-reset — the ONE-SHOT transient", () => {
	it("round-trips through the shared schema", () => {
		expect(uplinkFlowsResetEventSchema.safeParse(FLOWS_RESET).success).toBe(
			true,
		);
		expect(
			uplinkFlowsResetEventSchema.safeParse({ iface: "wwan1" }).success,
		).toBe(false);
	});

	it("raises a transient notice that NAMES THE CAUSE, not just the symptom", () => {
		messageHandler?.("uplink-flows-reset", FLOWS_RESET);

		const notices = flowsResetNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.name).toBe("uplink-flows-reset:wwan1");
		expect(notices[0]?.text).toContain("wwan1");
		// Transient: it expires on its own duration, so it can never linger.
		expect(notices[0]?.isPersistent).toBe(false);
		expect(notices[0]?.durationMs).toBeGreaterThan(0);
		expect(notices[0]?.isDismissable).toBe(true);
	});

	it("owns NO persisted slot — no getter on the store answers for it", () => {
		messageHandler?.("uplink-flows-reset", FLOWS_RESET);

		expect(getUplinks()).toBeUndefined();
		expect(getSharingDiag()).toBeUndefined();
		expect(getUplinkSteering()).toBeUndefined();
		expect(getUplinkShaper()).toBeUndefined();
		expect(getNetif()).toBeUndefined();
		// And the surface it feeds renders nothing about it.
		expect(renderedSection().bands.map((b) => b.kind)).toEqual(["sharing-off"]);
	});

	it("is handled EXACTLY ONCE for a duplicate broadcast", () => {
		messageHandler?.("uplink-flows-reset", FLOWS_RESET, 7);
		messageHandler?.("uplink-flows-reset", FLOWS_RESET, 7);
		messageHandler?.("uplink-flows-reset", FLOWS_RESET, 8);

		// Both the seq guard (same seq) and the name dedup (later seq, same
		// interface) collapse onto ONE notice.
		expect(flowsResetNotices()).toHaveLength(1);
	});

	it("keeps two DIFFERENT interfaces apart", () => {
		messageHandler?.("uplink-flows-reset", FLOWS_RESET);
		messageHandler?.(
			"uplink-flows-reset",
			uplinkFlowsResetEventSchema.parse({
				iface: "wwan2",
				linkId: "lnk_00112233445566aa",
			}),
		);

		expect(
			flowsResetNotices()
				.map((n) => n.name)
				.sort(),
		).toEqual(["uplink-flows-reset:wwan1", "uplink-flows-reset:wwan2"]);
	});

	it("is NOT replayed on reconnect — resetState leaves nothing to re-raise", () => {
		messageHandler?.("uplink-flows-reset", FLOWS_RESET);
		resetState();
		clearNotifications();
		initSubscriptions();

		// A fresh session re-hydrates every PERSISTENT topic and nothing else;
		// the drain that produced this notice is already history.
		messageHandler?.("uplinks", HEALTHY_UPLINKS);
		messageHandler?.("sharing_diag", DIAG_OK);
		messageHandler?.(
			"uplink-steering",
			uplinkSteeringStatusSchema.parse({ state: "available" }),
		);
		messageHandler?.(
			"uplink-shaper",
			uplinkShaperStatusSchema.parse({
				state: "available",
				mode: "idle",
				algorithm: "cake",
			}),
		);
		messageHandler?.("netif", SHARED_LAN_NETIF);

		expect(flowsResetNotices()).toHaveLength(0);
	});

	it("drops a malformed frame rather than raising an unnamed notice", () => {
		messageHandler?.("uplink-flows-reset", { iface: "" });
		messageHandler?.("uplink-flows-reset", null);

		expect(flowsResetNotices()).toHaveLength(0);
	});
});
