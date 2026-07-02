/*
 * Policy-route self-check (Wave-3, Todo 12).
 *
 * TDD contract for the bonded-interface policy-route diagnostic. The pure
 * parsers/derivation are tested over captured `ip rule show` + `ip route show
 * table <t>` fixture strings; the gated orchestration is tested through injected
 * deps so the isRealDevice() gate, the degrade-to-null failure modes, and the
 * mock seam are all exercised with no hardware and no `Bun.spawn`.
 *
 * Pinned properties:
 *   1. PARSE: `from <src> lookup <table>` rules parse; NO parseable rule → null
 *      (malformed → degrades, never crashes, never flags).
 *   2. DERIVE: iface→table is derived by matching each rule's `from <srcip>` to
 *      the live netif IPs — NO hardcoded table numbers. A bonded modem/wifi iface
 *      missing its source rule OR whose table lacks a default route is flagged;
 *      everything else stays clean.
 *   3. GATE: real device → spawn + check; emulated (withDeviceType) → null with
 *      NO spawn; every spawn/parse failure degrades to null.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	checkPolicyRoutes,
	collectPolicyRouteCandidates,
	defaultPolicyRouteCheckDeps,
	derivePolicyRouteMissing,
	isBondedModemOrWifiIface,
	isPolicyRouteMissing,
	type PolicyRouteCheckDeps,
	parseHasDefaultRoute,
	parseIpRules,
	refreshPolicyRouteFlags,
	resetPolicyRouteFlags,
} from "../modules/network/policy-route-check.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";

// ─── Captured fixtures ──────────────────────────────────────────────────────

// A realistic `ip rule show` snapshot: the 3 base rules every host carries, plus
// per-iface source rules for wlan0 (→ table 110) and usb0 (→ table 100). usb1's
// source rule is DELIBERATELY absent so it must be flagged.
const IP_RULE_SHOW_COMPLETE = `0:\tfrom all lookup local
100:\tfrom 192.168.2.100 lookup 110
100:\tfrom 10.0.0.5 lookup 100
100:\tfrom 10.0.1.5 lookup 101
32766:\tfrom all lookup main
32767:\tfrom all lookup default
`;

// Same as COMPLETE minus usb1's rule (10.0.1.5 → 101).
const IP_RULE_SHOW_MISSING_USB1 = `0:\tfrom all lookup local
100:\tfrom 192.168.2.100 lookup 110
100:\tfrom 10.0.0.5 lookup 100
32766:\tfrom all lookup main
32767:\tfrom all lookup default
`;

const IP_ROUTE_TABLE_110 = `default via 192.168.2.1 dev wlan0 proto static
192.168.2.0/24 dev wlan0 proto kernel scope link src 192.168.2.100
`;
const IP_ROUTE_TABLE_100 = `default via 10.0.0.1 dev usb0
10.0.0.0/24 dev usb0 proto kernel scope link src 10.0.0.5
`;
const IP_ROUTE_TABLE_101 = `default via 10.0.1.1 dev usb1
10.0.1.0/24 dev usb1 proto kernel scope link src 10.0.1.5
`;
// A table that exists but has NO default route (link-scope only).
const IP_ROUTE_TABLE_NO_DEFAULT = `10.0.0.0/24 dev usb0 proto kernel scope link src 10.0.0.5
`;

// Live netif snapshot: eth0 (management, NOT bonded), wlan0/usb0/usb1 (bonded).
const NETIF = {
	eth0: { ip: "192.168.1.100", enabled: true },
	wlan0: { ip: "192.168.2.100", enabled: true },
	usb0: { ip: "10.0.0.5", enabled: true },
	usb1: { ip: "10.0.1.5", enabled: true },
};

function routeTableFixture(table: string): string {
	switch (table) {
		case "110":
			return IP_ROUTE_TABLE_110;
		case "100":
			return IP_ROUTE_TABLE_100;
		case "101":
			return IP_ROUTE_TABLE_101;
		default:
			return "";
	}
}

afterEach(() => {
	resetPolicyRouteFlags();
});

// ─── parseIpRules ────────────────────────────────────────────────────────────

describe("parseIpRules", () => {
	it("parses every `from <src> lookup <table>` line", () => {
		const rules = parseIpRules(IP_RULE_SHOW_COMPLETE);
		expect(rules).not.toBeNull();
		expect(rules).toContainEqual({ src: "192.168.2.100", table: "110" });
		expect(rules).toContainEqual({ src: "10.0.0.5", table: "100" });
		expect(rules).toContainEqual({ src: "10.0.1.5", table: "101" });
		// base rules with `from all` are captured too
		expect(rules).toContainEqual({ src: "all", table: "local" });
	});

	it("returns null for malformed/unparseable output (no rule line)", () => {
		expect(parseIpRules("this is not ip rule output at all")).toBeNull();
		expect(parseIpRules("")).toBeNull();
		expect(parseIpRules("\n\n   \n")).toBeNull();
	});
});

// ─── parseHasDefaultRoute ────────────────────────────────────────────────────

describe("parseHasDefaultRoute", () => {
	it("is true when a default route is present", () => {
		expect(parseHasDefaultRoute(IP_ROUTE_TABLE_110)).toBe(true);
		expect(parseHasDefaultRoute(IP_ROUTE_TABLE_100)).toBe(true);
	});

	it("is false when the table has no default route", () => {
		expect(parseHasDefaultRoute(IP_ROUTE_TABLE_NO_DEFAULT)).toBe(false);
		expect(parseHasDefaultRoute("")).toBe(false);
	});
});

// ─── isBondedModemOrWifiIface ────────────────────────────────────────────────

describe("isBondedModemOrWifiIface", () => {
	it("recognizes wifi + modem class interfaces", () => {
		for (const n of ["wlan0", "wlan1", "usb0", "wwan0", "wwp0s20f0u3i12"]) {
			expect(isBondedModemOrWifiIface(n)).toBe(true);
		}
	});

	it("rejects ethernet / loopback / virtual interfaces", () => {
		for (const n of ["eth0", "lo", "docker0", "l4tbr0"]) {
			expect(isBondedModemOrWifiIface(n)).toBe(false);
		}
	});
});

// ─── collectPolicyRouteCandidates ────────────────────────────────────────────

describe("collectPolicyRouteCandidates", () => {
	it("keeps only enabled, IP-bearing, modem/wifi interfaces", () => {
		const candidates = collectPolicyRouteCandidates({
			eth0: { ip: "192.168.1.100", enabled: true }, // not bonded
			wlan0: { ip: "192.168.2.100", enabled: true }, // ✓
			usb0: { ip: "10.0.0.5", enabled: true }, // ✓
			usb1: { ip: undefined, enabled: true }, // no IP
			usb2: { ip: "10.0.2.5", enabled: false }, // disabled
		});
		const names = candidates.map((c) => c.name).sort();
		expect(names).toEqual(["usb0", "wlan0"]);
	});
});

// ─── derivePolicyRouteMissing (the failure-mode heart) ───────────────────────

describe("derivePolicyRouteMissing", () => {
	const candidates = [
		{ name: "wlan0", ip: "192.168.2.100" },
		{ name: "usb0", ip: "10.0.0.5" },
		{ name: "usb1", ip: "10.0.1.5" },
	];

	it("flags NOTHING when every iface has its rule + a default route", () => {
		const rules = parseIpRules(IP_RULE_SHOW_COMPLETE) ?? [];
		const flagged = derivePolicyRouteMissing(
			candidates,
			rules,
			() => true, // every table has a default
		);
		expect(flagged.size).toBe(0);
	});

	it("flags ONLY the iface whose source rule is missing", () => {
		const rules = parseIpRules(IP_RULE_SHOW_MISSING_USB1) ?? [];
		const flagged = derivePolicyRouteMissing(candidates, rules, () => true);
		expect([...flagged]).toEqual(["usb1"]);
	});

	it("flags an iface whose rule exists but table lacks a default route", () => {
		const rules = parseIpRules(IP_RULE_SHOW_COMPLETE) ?? [];
		// table 100 (usb0) has no default; 110 + 101 do
		const flagged = derivePolicyRouteMissing(
			candidates,
			rules,
			(table) => table !== "100",
		);
		expect([...flagged]).toEqual(["usb0"]);
	});
});

// ─── checkPolicyRoutes (gated orchestration) ─────────────────────────────────

function makeSpyDeps(
	overrides: Partial<PolicyRouteCheckDeps> = {},
): PolicyRouteCheckDeps & {
	ruleSpy: ReturnType<typeof mock>;
	routeSpy: ReturnType<typeof mock>;
} {
	const ruleSpy = mock(async () => IP_RULE_SHOW_COMPLETE);
	const routeSpy = mock(async (table: string) => routeTableFixture(table));
	return {
		isRealDevice: async () => true,
		shouldUseMocks: () => false,
		resolveMockPolicyRouteMissing: () => null,
		runIpRuleShow: ruleSpy,
		runIpRouteShowTable: routeSpy,
		...overrides,
		ruleSpy,
		routeSpy,
	};
}

describe("checkPolicyRoutes", () => {
	it("real device + complete rules → no flags (empty set)", async () => {
		const deps = makeSpyDeps();
		const flagged = await checkPolicyRoutes(NETIF, deps);
		expect(flagged).not.toBeNull();
		expect(flagged?.size).toBe(0);
		expect(deps.ruleSpy).toHaveBeenCalledTimes(1);
	});

	it("real device + usb1 rule missing → usb1 flagged, others clean", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => IP_RULE_SHOW_MISSING_USB1),
		});
		const flagged = await checkPolicyRoutes(NETIF, deps);
		expect([...(flagged ?? [])]).toEqual(["usb1"]);
	});

	it("malformed `ip rule show` output → null (degrade, no flags, no crash)", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => "garbage output — not ip rule at all"),
		});
		expect(await checkPolicyRoutes(NETIF, deps)).toBeNull();
	});

	it("spawn error → null (degrade, never throws into the loop)", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => {
				throw new Error("ip: command not found");
			}),
		});
		expect(await checkPolicyRoutes(NETIF, deps)).toBeNull();
	});

	it("`ip route show table` error → null (degrade)", async () => {
		const deps = makeSpyDeps({
			runIpRouteShowTable: mock(async () => {
				throw new Error("route query failed");
			}),
		});
		expect(await checkPolicyRoutes(NETIF, deps)).toBeNull();
	});

	it("emulated host (withDeviceType) → null with NO spawn (no-op gate)", async () => {
		await withDeviceType("emulated", async () => {
			const ruleSpy = mock(async () => IP_RULE_SHOW_COMPLETE);
			const routeSpy = mock(async (t: string) => routeTableFixture(t));
			const result = await checkPolicyRoutes(NETIF, {
				...defaultPolicyRouteCheckDeps,
				shouldUseMocks: () => false,
				runIpRuleShow: ruleSpy,
				runIpRouteShowTable: routeSpy,
			});
			expect(result).toBeNull();
			expect(ruleSpy).not.toHaveBeenCalled();
			expect(routeSpy).not.toHaveBeenCalled();
		});
	});

	it("dev/mock seam simulates a missing rule without spawning", async () => {
		const ruleSpy = mock(async () => IP_RULE_SHOW_COMPLETE);
		const result = await checkPolicyRoutes(NETIF, {
			isRealDevice: async () => false,
			shouldUseMocks: () => true,
			resolveMockPolicyRouteMissing: () => new Set(["usb1"]),
			runIpRuleShow: ruleSpy,
			runIpRouteShowTable: mock(async () => ""),
		});
		expect([...(result ?? [])]).toEqual(["usb1"]);
		expect(ruleSpy).not.toHaveBeenCalled();
	});
});

// ─── refreshPolicyRouteFlags + isPolicyRouteMissing (cache used by netif) ─────

describe("refreshPolicyRouteFlags / isPolicyRouteMissing", () => {
	it("caches the flagged set for the synchronous netif payload getter", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => IP_RULE_SHOW_MISSING_USB1),
		});
		await refreshPolicyRouteFlags(NETIF, deps);
		expect(isPolicyRouteMissing("usb1")).toBe(true);
		expect(isPolicyRouteMissing("wlan0")).toBe(false);
		expect(isPolicyRouteMissing("usb0")).toBe(false);
	});

	it("a null result (degrade) clears all flags — nothing is flagged", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => {
				throw new Error("boom");
			}),
		});
		await refreshPolicyRouteFlags(NETIF, deps);
		expect(isPolicyRouteMissing("usb1")).toBe(false);
	});

	it("resetPolicyRouteFlags clears the cache", async () => {
		const deps = makeSpyDeps({
			runIpRuleShow: mock(async () => IP_RULE_SHOW_MISSING_USB1),
		});
		await refreshPolicyRouteFlags(NETIF, deps);
		expect(isPolicyRouteMissing("usb1")).toBe(true);
		resetPolicyRouteFlags();
		expect(isPolicyRouteMissing("usb1")).toBe(false);
	});
});
