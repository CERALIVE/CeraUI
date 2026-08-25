/*
 * Sharing-coexistence diagnostics — the verdict table.
 *
 * Every case drives the SHIPPED pure derivation over captured-shape `ip rule` /
 * `nft list ruleset` output. The discipline under test is `policy-route-check`'s:
 * an indeterminate reading is `unknown`, never a guessed pass or fail, and the
 * strongest verdict this module can ever reach is `degraded` — nothing here
 * gates a stream, an interface or a mutation.
 */
import { describe, expect, it } from "bun:test";

import {
	checkFirewallBackend,
	checkForeignTables,
	checkSharedNat,
	checkSteeringRules,
	deriveSharingDiag,
	EXPECTED_FIREWALL_BACKEND,
	type NmSharedZone,
	rollupSharingDiagState,
} from "../modules/network/sharing-diag/checks.ts";
import {
	findNftTable,
	parseNftRuleset,
	resolveNftPriority,
} from "../modules/network/sharing-diag/nft-ruleset.ts";
import { FOREIGN_NFT_TABLES } from "../modules/network/uplink-steering/contracts.ts";
import {
	ipRuleShow,
	nftRuleset,
	SECOND_SHARED_PREFIX,
	SHARED_PREFIX,
} from "./sharing-diag-test-fixtures.ts";

const HOTSPOT: NmSharedZone[] = [{ ifname: "wlan0", ipv4Cidr: SHARED_PREFIX }];

function healthy() {
	return deriveSharingDiag(
		{
			firewallBackend: EXPECTED_FIREWALL_BACKEND,
			ipRuleShow: ipRuleShow(),
			nftRuleset: nftRuleset(),
			sharedZones: HOTSPOT,
		},
		1_000,
	);
}

describe("healthy coexistence", () => {
	it("reports every check ok and rolls up ok", () => {
		const diag = healthy();

		expect(diag.state).toBe("ok");
		expect(diag.firewallBackend.state).toBe("ok");
		expect(diag.steeringRules.state).toBe("ok");
		expect(diag.sharedNat.state).toBe("ok");
		expect(diag.foreignTables.state).toBe("ok");
		expect(diag.checkedAt).toBe(1_000);
	});

	it("counts NetworkManager's own masquerade, never the steering table's", () => {
		// The `ceralive_share` table masquerades the SAME prefix by design. If
		// table provenance were ignored it would satisfy the floor check on its
		// own, so removing NM's table must still report the floor as missing.
		const withoutNmFloor = checkSharedNat(
			nftRuleset({ sharedPrefixes: [] }),
			HOTSPOT,
		);

		expect(withoutNmFloor.state).toBe("degraded");
		expect(withoutNmFloor.reason).toBe("shared_nat_missing");
	});
});

describe("the firewall-backend pin", () => {
	it("a PRE-PIN image is degraded with its own reason, never a mismatch", () => {
		const check = checkFirewallBackend(null);

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("firewall_backend_unpinned");
	});

	it("an explicit non-nftables backend is a mismatch", () => {
		const check = checkFirewallBackend("iptables");

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("firewall_backend_mismatch");
	});

	it("an unreadable configuration yields NO verdict", () => {
		expect(checkFirewallBackend(undefined)).toEqual({
			state: "unknown",
			detail: "NetworkManager configuration could not be read",
		});
	});

	it("a missing pin degrades the rollup without touching the other three", () => {
		const diag = deriveSharingDiag(
			{
				firewallBackend: null,
				ipRuleShow: ipRuleShow(),
				nftRuleset: nftRuleset(),
				sharedZones: HOTSPOT,
			},
			1,
		);

		expect(diag.state).toBe("degraded");
		expect(diag.firewallBackend.reason).toBe("firewall_backend_unpinned");
		expect(diag.steeringRules.state).toBe("ok");
		expect(diag.sharedNat.state).toBe("ok");
		expect(diag.foreignTables.state).toBe("ok");
	});
});

describe("steering-rule placement", () => {
	it("a rule ahead of the image's source routing is a shadow", () => {
		const check = checkSteeringRules(ipRuleShow({ steeringPriority: 90 }));

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("steering_rule_shadows_source_route");
	});

	it("a rule after source routing but off the constant is drift", () => {
		const check = checkSteeringRules(ipRuleShow({ steeringPriority: 20_000 }));

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("steering_rule_priority_drift");
	});

	it("no steering rules at all is ok — there is nothing to shadow", () => {
		expect(checkSteeringRules(ipRuleShow({ steeringSlots: [] }))).toEqual({
			state: "ok",
		});
	});

	it("unparseable output yields NO verdict rather than a clean bill", () => {
		expect(checkSteeringRules("Error: argument is wrong\n").state).toBe(
			"unknown",
		);
		expect(checkSteeringRules(undefined).state).toBe("unknown");
	});
});

describe("NetworkManager's shared-mode NAT floor", () => {
	it("is checked per LIVE prefix, not an assumed 10.42.0.0/24", () => {
		const relocated: NmSharedZone[] = [
			{ ifname: "wlan0", ipv4Cidr: SECOND_SHARED_PREFIX },
		];

		const check = checkSharedNat(
			nftRuleset({ sharedPrefixes: [SECOND_SHARED_PREFIX] }),
			relocated,
		);

		expect(check.state).toBe("ok");
		// …and the DEFAULT prefix, which the device is not serving, must not
		// silently satisfy it.
		expect(
			checkSharedNat(nftRuleset({ sharedPrefixes: [SHARED_PREFIX] }), relocated)
				.reason,
		).toBe("shared_nat_missing");
	});

	it("two NetworkManager masquerades for one prefix is duplicated NAT", () => {
		const check = checkSharedNat(
			nftRuleset({ duplicateSharedPrefix: SHARED_PREFIX }),
			HOTSPOT,
		);

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("shared_nat_duplicated");
	});

	it("a shared interface with no address yet yields NO verdict", () => {
		const check = checkSharedNat(nftRuleset(), [
			{ ifname: "wlan0", ipv4Cidr: undefined },
		]);

		expect(check.state).toBe("unknown");
	});

	it("a missing prefix outranks an indeterminate one", () => {
		const check = checkSharedNat(nftRuleset({ sharedPrefixes: [] }), [
			{ ifname: "wlan0", ipv4Cidr: SHARED_PREFIX },
			{ ifname: "eth1", ipv4Cidr: undefined },
		]);

		expect(check.reason).toBe("shared_nat_missing");
	});

	it("withholds when NetworkManager could not be enumerated", () => {
		expect(checkSharedNat(nftRuleset(), undefined).state).toBe("unknown");
	});

	it("no shared profile at all is ok — nothing is being shared", () => {
		expect(checkSharedNat(nftRuleset(), [])).toEqual({ state: "ok" });
	});
});

describe("foreign-table integrity", () => {
	it("an intact ingest firewall is ok", () => {
		expect(checkForeignTables(nftRuleset())).toEqual({ state: "ok" });
	});

	it("a moved hook priority is a modification", () => {
		const check = checkForeignTables(nftRuleset({ ingestFwPriority: 0 }));

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("foreign_table_modified");
	});

	it("a CeraLive rule inside the foreign table is a modification", () => {
		const check = checkForeignTables(
			nftRuleset({ ingestFwCarriesShareRule: true }),
		);

		expect(check.state).toBe("degraded");
		expect(check.reason).toBe("foreign_table_modified");
	});

	it("an ingest firewall that was never installed yields NO verdict", () => {
		// The ingest gateway is operator-disable-able, so its absence is a
		// statement about the image — never evidence that steering touched it.
		const check = checkForeignTables(
			nftRuleset({ ingestFwPriority: "absent" }),
		);

		expect(check.state).toBe("unknown");
		expect(check.reason).toBeUndefined();
	});

	it("an unreadable ruleset yields NO verdict", () => {
		expect(checkForeignTables("").state).toBe("unknown");
		expect(checkForeignTables(undefined).state).toBe("unknown");
	});
});

describe("the ambiguous device", () => {
	it("withholds every check it could not establish and never claims ok", () => {
		const diag = deriveSharingDiag(
			{
				firewallBackend: undefined,
				ipRuleShow: undefined,
				nftRuleset: undefined,
				sharedZones: undefined,
			},
			42,
		);

		expect(diag.state).toBe("unknown");
		expect(diag.firewallBackend.state).toBe("unknown");
		expect(diag.steeringRules.state).toBe("unknown");
		expect(diag.sharedNat.state).toBe("unknown");
		expect(diag.foreignTables.state).toBe("unknown");
	});

	it("rolls degraded over unknown over ok", () => {
		expect(
			rollupSharingDiagState([{ state: "ok" }, { state: "unknown" }]),
		).toBe("unknown");
		expect(
			rollupSharingDiagState([
				{ state: "unknown" },
				{ state: "degraded", reason: "shared_nat_missing" },
			]),
		).toBe("degraded");
		expect(rollupSharingDiagState([{ state: "ok" }, { state: "ok" }])).toBe(
			"ok",
		);
	});
});

describe("the nft reader", () => {
	it("resolves every priority spelling nft prints", () => {
		expect(resolveNftPriority("-10")).toBe(-10);
		expect(resolveNftPriority("filter - 10")).toBe(-10);
		expect(resolveNftPriority("srcnat")).toBe(100);
		expect(resolveNftPriority("dstnat + 5")).toBe(-95);
		expect(resolveNftPriority("something-else")).toBeUndefined();
	});

	it("accepts the bare numeric hook form older nft prints", () => {
		const bare = [
			`table ${FOREIGN_NFT_TABLES[0].family} ${FOREIGN_NFT_TABLES[0].name} {`,
			`\tchain ${FOREIGN_NFT_TABLES[0].hooks[0].chain} {`,
			`\t\ttype filter hook ${FOREIGN_NFT_TABLES[0].hooks[0].hook} priority ${FOREIGN_NFT_TABLES[0].hooks[0].priority}; policy accept;`,
			"\t}",
			"}",
			"",
		].join("\n");

		expect(checkForeignTables(bare).state).toBe("ok");
	});

	it("returns null when not a single table parses", () => {
		expect(parseNftRuleset("")).toBeNull();
		expect(parseNftRuleset("nft: command not found\n")).toBeNull();
	});

	it("keeps rules under the table that owns them", () => {
		const tables = parseNftRuleset(nftRuleset());
		expect(tables).not.toBeNull();
		if (tables === null) return;

		const share = findNftTable(tables, "inet", "ceralive_share");
		const nm = findNftTable(tables, "ip", "nm-shared-wlan0");
		expect(share?.chains[0]?.rules.join()).toContain("masquerade");
		expect(nm?.chains[0]?.rules.join()).toContain("masquerade");
		expect(findNftTable(tables, "inet", "nm-shared-wlan0")).toBeUndefined();
	});
});
