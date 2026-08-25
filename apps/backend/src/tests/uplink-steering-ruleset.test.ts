/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
	CLIENT_FLOW_NAMESPACE,
	CLIENT_FLOW_NAMESPACE_MASK,
	FOREIGN_NFT_TABLES,
	FWMARK_RULE_PRIORITY,
	MAX_STEERING_UPLINKS,
	SHARE_RULESET_PATH,
	SHARE_SERVICE,
	SHARE_TABLE,
	UPLINK_MARK_MASK,
	WEIGHT_BUCKET_MODULUS,
} from "../modules/network/uplink-steering/contracts.ts";
import {
	apportionWeightBuckets,
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";

describe("uplink-steering carrier contract", () => {
	test("pins the image-owned carrier names byte-for-byte", () => {
		expect(SHARE_SERVICE).toBe("ceralive-share.service");
		expect(SHARE_RULESET_PATH).toBe("/run/ceralive/share.nft");
		expect(SHARE_TABLE).toEqual({ family: "inet", name: "ceralive_share" });
		expect(FOREIGN_NFT_TABLES).toEqual([
			{
				family: "inet",
				name: "ceralive_ingest_fw",
				hooks: [{ chain: "input", hook: "input", priority: -10 }],
			},
		]);
		expect(FWMARK_RULE_PRIORITY).toBeGreaterThan(100);
	});
});

describe("stableUplinkMark", () => {
	test("is deterministic, identity-keyed, and confined to its namespace", () => {
		const first = stableUplinkMark("usb-serial:2c7c:0123456789");
		const same = stableUplinkMark("usb-serial:2c7c:0123456789");
		const other = stableUplinkMark("id-path:pci-0000:01:00.0-usb-0:2");

		expect(first).toBe(same);
		expect(first).not.toBe(other);
		expect((first & CLIENT_FLOW_NAMESPACE_MASK) >>> 0).toBe(
			CLIENT_FLOW_NAMESPACE,
		);
		expect(first & ~UPLINK_MARK_MASK).toBe(0);
	});

	test("keeps surviving marks stable across add, remove, reorder, and reweight", () => {
		const before = ["wifi-a", "cell-a", "cell-b"];
		const changed = ["cell-b", "ethernet-new", "wifi-a"];
		const beforeMarks = new Map(
			before.map((identity) => [identity, stableUplinkMark(identity)]),
		);
		const changedMarks = new Map(
			changed.map((identity) => [identity, stableUplinkMark(identity)]),
		);
		const wifiBefore = beforeMarks.get("wifi-a");
		if (wifiBefore === undefined) throw new Error("missing WiFi mark fixture");

		expect(changedMarks.get("wifi-a")).toBe(wifiBefore);
		expect(changedMarks.get("cell-b")).toBe(beforeMarks.get("cell-b"));
		expect(stableUplinkMark("wifi-a")).toBe(wifiBefore);
	});
});

describe("buildShareRuleset", () => {
	test("apportions a fixed modulus exactly for every supported weight mix", () => {
		for (const weights of [
			[100],
			[100, 25],
			[100, 50, 25],
			[100, 100, 75, 50, 25, 1],
		]) {
			const uplinks = weights.map((weight, index) =>
				steeringUplink(`identity-${index}`, `wan${index}`, weight),
			);
			const buckets = apportionWeightBuckets(uplinks);
			expect(buckets).toHaveLength(weights.length);
			expect(buckets.reduce((sum, count) => sum + count, 0)).toBe(
				WEIGHT_BUCKET_MODULUS,
			);
			expect(buckets.every((count) => count > 0)).toBe(true);
		}
	});

	test("has exact golden output for the declared zero-through-six target", () => {
		for (const count of [0, 1, 2, 3, MAX_STEERING_UPLINKS]) {
			const ruleset = buildShareRuleset({
				clientZones: [
					{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
					{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
				],
				uplinks: Array.from({ length: count }, (_, index) =>
					steeringUplink(
						`golden-${index}`,
						`wan${index}`,
						Math.max(1, 100 - index * 15),
					),
				),
			});
			expect(ruleset).toMatchSnapshot(`uplinks-${count}`);
		}
	});

	test("has exact golden output for hotspot, shared-lan, and combined zones", () => {
		for (const [name, clientZones] of [
			["hotspot", [{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" }]],
			["shared-lan", [{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" }]],
			[
				"combined",
				[
					{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
					{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
				],
			],
		] as const) {
			expect(
				buildShareRuleset({
					clientZones,
					uplinks: [steeringUplink("zone-golden", "wan0", 100)],
				}),
			).toMatchSnapshot(name);
		}
	});

	test("is full-state and empty-set safe without touching foreign tables", () => {
		const ruleset = buildShareRuleset({ clientZones: [], uplinks: [] });

		expect(ruleset).toBe(`add table inet ceralive_share
delete table inet ceralive_share

table inet ceralive_share {
	chain prerouting {
		type filter hook prerouting priority mangle; policy accept;
	}

	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
	}
}
`);
		expect(ruleset).not.toContain("flush ruleset");
		expect(ruleset).not.toContain("ceralive_ingest_fw");
		expect(ruleset).not.toContain("hook output");
	});

	test("renders weighted first-packet selection, restore, and provenance-scoped NAT", () => {
		const wwanMark = stableUplinkMark("usb-serial:wwan-a");
		const wifiMark = stableUplinkMark("wifi-mac:00:11:22:33:44:55");
		const ruleset = buildShareRuleset({
			clientZones: [
				{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
				{ ifname: "eth1", ipv4Cidr: "10.43.0.0/24" },
			],
			uplinks: [
				{
					identity: "usb-serial:wwan-a",
					ifname: "wwan0",
					mark: wwanMark,
					selectable: true,
					weight: 100,
				},
				{
					identity: "wifi-mac:00:11:22:33:44:55",
					ifname: "wlan0",
					mark: wifiMark,
					selectable: true,
					weight: 25,
				},
			],
		});

		expect(ruleset).toContain(
			`numgen random mod ${WEIGHT_BUCKET_MODULUS} vmap @uplink_verdicts`,
		);
		expect(ruleset).toContain("0-1999 : jump select_0");
		expect(ruleset).toContain("2000-9999 : jump select_1");
		expect(ruleset).toContain(
			`meta mark set (meta mark & 0x000000ff) | ${hexMark(wifiMark)}`,
		);
		expect(ruleset).toContain(
			`meta mark set (meta mark & 0x000000ff) | ${hexMark(wwanMark)}`,
		);
		expect(ruleset).toContain("ct state established,related");
		expect(ruleset).toContain(
			`ct mark set (ct mark & 0x000000ff) | ${hexMark(wifiMark)}`,
		);
		expect(ruleset).toContain(
			`ct mark set (ct mark & 0x000000ff) | ${hexMark(wwanMark)}`,
		);

		for (const line of ruleset.split("\n")) {
			if (line.includes('comment "restore client flow"')) {
				expect(line).toContain("iifname");
				expect(line).toContain("ip saddr");
			}
			if (line.includes('comment "select client uplink"')) {
				expect(line).toContain("iifname");
				expect(line).toContain("ip saddr");
			}
			if (line.includes("masquerade")) {
				expect(line).toContain("iifname");
				expect(line).toContain("ip saddr");
				expect(line).toContain("ct mark & 0xffffff00 ==");
				expect(line).toContain("oifname");
			}
		}

		expect(ruleset).not.toContain("hook output");
		expect(ruleset).not.toMatch(/\b(?:limit rate|meter|police)\b/);
	});

	test("emits bookworm-compatible single-register mark expressions", () => {
		// Given a client flow whose low mark byte belongs to another consumer.
		const uplink = steeringUplink("bookworm-parser", "wan0", 100);

		// When the complete replacement ruleset is rendered.
		const ruleset = buildShareRuleset({
			clientZones: [{ ifname: "client0", ipv4Cidr: "10.42.0.0/24" }],
			uplinks: [uplink],
		});

		// Then every OR combines one runtime register with an immediate value.
		expect(ruleset).toStartWith(
			"add table inet ceralive_share\ndelete table inet ceralive_share\n",
		);
		expect(ruleset).toContain(
			`ct mark set (ct mark & 0x000000ff) | ${hexMark(uplink.mark)}`,
		);
		expect(ruleset).toContain(
			`ct mark & 0xffffff00 == ${hexMark(uplink.mark)} meta mark set meta mark & 0x000000ff | ${hexMark(uplink.mark)} comment "restore client flow"`,
		);
		expect(ruleset).not.toContain("| (meta mark &");
		expect(ruleset).not.toContain("| (ct mark &");
		expect(ruleset).not.toContain("destroy table");
	});

	test("keeps retained hard-down support out of new-flow selection", () => {
		const retainedMark = stableUplinkMark("usb-serial:retained");
		const ruleset = buildShareRuleset({
			clientZones: [{ ifname: "eth1", ipv4Cidr: "10.43.0.0/24" }],
			uplinks: [
				{
					identity: "usb-serial:retained",
					ifname: "wwan0",
					mark: retainedMark,
					selectable: false,
					weight: 0,
				},
			],
		});

		expect(ruleset).not.toContain("map uplink_verdicts");
		expect(ruleset).not.toContain("select client uplink");
		expect(ruleset).toContain(
			`ct mark & 0xffffff00 == ${hexMark(retainedMark)} oifname "wwan0" masquerade`,
		);
	});
});

function steeringUplink(identity: string, ifname: string, weight: number) {
	return {
		identity,
		ifname,
		mark: stableUplinkMark(identity),
		selectable: true,
		weight,
	};
}

function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
