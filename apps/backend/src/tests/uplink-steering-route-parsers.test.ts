import { describe, expect, it } from "bun:test";
import {
	isEthernetUplinkIface,
	parseHasDefaultRoute,
	parseIpRules,
} from "../modules/network/uplink-steering/route-parsers.ts";

const IP_RULE_SHOW_COMPLETE = `0:\tfrom all lookup local
100:\tfrom 192.168.2.100 lookup 110
100:\tfrom 10.0.0.5 lookup 100
100:\tfrom 10.0.1.5 lookup 101
32766:\tfrom all lookup main
32767:\tfrom all lookup default
`;

const IP_ROUTE_TABLE_110 = `default via 192.168.2.1 dev wlan0 proto static
192.168.2.0/24 dev wlan0 proto kernel scope link src 192.168.2.100
`;
const IP_ROUTE_TABLE_100 = `default via 10.0.0.1 dev usb0
10.0.0.0/24 dev usb0 proto kernel scope link src 10.0.0.5
`;
// A table that exists but has NO default route (link-scope only).
const IP_ROUTE_TABLE_NO_DEFAULT = `10.0.0.0/24 dev usb0 proto kernel scope link src 10.0.0.5
`;

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

describe("isEthernetUplinkIface", () => {
	it("recognizes wired interfaces only", () => {
		for (const name of ["eth0", "enp1s0", "enx344b50000000"])
			expect(isEthernetUplinkIface(name)).toBe(true);
		for (const name of ["wlan1", "wwan0", "ppp0", "usb0", "lo"])
			expect(isEthernetUplinkIface(name)).toBe(false);
	});
});
