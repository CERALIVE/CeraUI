/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * The four coexistence verdicts, as pure functions over captured device output.
 *
 * Every one of them mirrors `policy-route-check.ts`'s honesty discipline: an
 * indeterminate reading resolves to `unknown` and NEVER to a guessed pass or
 * fail. Nothing here gates anything — the whole module is read-only, and the
 * strongest thing it can say is `degraded`.
 */

import type {
	SharingDiag,
	SharingDiagCheck,
	SharingDiagState,
} from "@ceraui/rpc/schemas";

import {
	CLIENT_FLOW_NAMESPACE,
	FOREIGN_NFT_TABLES,
	FWMARK_RULE_PRIORITY,
	SHARE_TABLE,
	SOURCE_ROUTE_RULE_PRIORITY,
} from "../uplink-steering/contracts.ts";
import { parseIpRuleBands } from "./ip-rules.ts";
import { findNftTable, type NftTable, parseNftRuleset } from "./nft-ruleset.ts";

export const EXPECTED_FIREWALL_BACKEND = "nftables" as const;

// Derived from the mark layout rather than typed as a literal, so a change to
// the namespace byte in uplink-steering/contracts.ts cannot leave this reader
// hunting for a provenance marker the steering layer no longer writes.
const NAMESPACE_BYTE = ((CLIENT_FLOW_NAMESPACE >>> 24) & 0xff)
	.toString(16)
	.padStart(2, "0");
const CLIENT_FLOW_MARK_RE = new RegExp(`0x${NAMESPACE_BYTE}[0-9a-f]{6}`, "i");

/** A NetworkManager profile that is ACTIVE in `ipv4.method shared` right now. */
export interface NmSharedZone {
	readonly ifname: string;
	/**
	 * The interface's LIVE prefix. `undefined` when the interface holds no
	 * address yet — the shared subnet is NM's to pick, so there is nothing to
	 * assume and the zone is reported as indeterminate rather than as missing.
	 */
	readonly ipv4Cidr: string | undefined;
}

export interface SharingDiagInputs {
	/**
	 * The explicit `firewall-backend` value found in NetworkManager's config,
	 * `null` when no explicit pin exists anywhere (a PRE-PIN image), or
	 * `undefined` when the configuration could not be read.
	 */
	readonly firewallBackend: string | null | undefined;
	readonly ipRuleShow: string | undefined;
	readonly nftRuleset: string | undefined;
	readonly sharedZones: readonly NmSharedZone[] | undefined;
}

const OK: SharingDiagCheck = { state: "ok" };

function unknown(detail?: string): SharingDiagCheck {
	return detail === undefined
		? { state: "unknown" }
		: { state: "unknown", detail };
}

function degraded(
	reason: SharingDiagCheck["reason"],
	detail: string,
): SharingDiagCheck {
	return { state: "degraded", reason, detail };
}

export function checkFirewallBackend(
	value: string | null | undefined,
): SharingDiagCheck {
	if (value === undefined) {
		return unknown("NetworkManager configuration could not be read");
	}
	if (value === null) {
		return degraded(
			"firewall_backend_unpinned",
			`no explicit firewall-backend is pinned; expected ${EXPECTED_FIREWALL_BACKEND}`,
		);
	}
	if (value === EXPECTED_FIREWALL_BACKEND) return OK;
	return degraded(
		"firewall_backend_mismatch",
		`firewall-backend is ${value}; expected ${EXPECTED_FIREWALL_BACKEND}`,
	);
}

/**
 * The steering band must sit strictly after every source-routing rule the image
 * installs, so a client flow is only ever re-routed once the source rules have
 * had their say. The floor is the HIGHER of the pinned contract priority and
 * the highest source-route priority actually observed, so a device whose image
 * moved its own rules is judged on what it really does.
 */
export function checkSteeringRules(
	ipRuleShow: string | undefined,
): SharingDiagCheck {
	if (ipRuleShow === undefined) {
		return unknown("`ip rule show` could not be read");
	}
	const parsed = parseIpRuleBands(ipRuleShow);
	if (parsed === null) return unknown("`ip rule show` output was unparseable");
	if (parsed.steering.length === 0) return OK;

	const floor = Math.max(
		SOURCE_ROUTE_RULE_PRIORITY,
		...parsed.sourceRoutes.map((rule) => rule.priority),
	);
	const shadowing = parsed.steering.filter((rule) => rule.priority <= floor);
	if (shadowing.length > 0) {
		const priorities = shadowing.map((rule) => rule.priority).join(", ");
		return degraded(
			"steering_rule_shadows_source_route",
			`steering rules at priority ${priorities} run at or before source routing (${floor})`,
		);
	}

	const drifted = parsed.steering.filter(
		(rule) => rule.priority !== FWMARK_RULE_PRIORITY,
	);
	if (drifted.length > 0) {
		const priorities = drifted.map((rule) => rule.priority).join(", ");
		return degraded(
			"steering_rule_priority_drift",
			`steering rules at priority ${priorities}; expected ${FWMARK_RULE_PRIORITY}`,
		);
	}

	return OK;
}

/**
 * NetworkManager's shared-mode masquerade is the working FLOOR the hotspot keeps
 * even when the steering layer is down, so it is checked per ACTIVE shared
 * prefix and identified by TABLE PROVENANCE: a masquerade rule inside
 * `inet ceralive_share` is CeraUI's own per-uplink NAT, which coexists with the
 * floor by design and can never stand in for it.
 */
export function checkSharedNat(
	nftRuleset: string | undefined,
	sharedZones: readonly NmSharedZone[] | undefined,
): SharingDiagCheck {
	if (nftRuleset === undefined) {
		return unknown("`nft list ruleset` could not be read");
	}
	const tables = parseNftRuleset(nftRuleset);
	if (tables === null) return unknown("`nft list ruleset` was unparseable");
	if (sharedZones === undefined) {
		return unknown("NetworkManager shared profiles could not be enumerated");
	}
	if (sharedZones.length === 0) return OK;

	const foreign = foreignMasqueradeRules(tables);
	const missing: string[] = [];
	const duplicated: string[] = [];
	let indeterminate = false;

	for (const zone of sharedZones) {
		if (zone.ipv4Cidr === undefined) {
			indeterminate = true;
			continue;
		}
		const matches = foreign.filter((rule) =>
			rule.includes(`ip saddr ${zone.ipv4Cidr}`),
		);
		if (matches.length === 0) missing.push(`${zone.ifname} ${zone.ipv4Cidr}`);
		else if (matches.length > 1)
			duplicated.push(`${zone.ifname} ${zone.ipv4Cidr}`);
	}

	if (missing.length > 0) {
		return degraded(
			"shared_nat_missing",
			`no NetworkManager masquerade for ${missing.join(", ")}`,
		);
	}
	if (duplicated.length > 0) {
		return degraded(
			"shared_nat_duplicated",
			`more than one NetworkManager masquerade for ${duplicated.join(", ")}`,
		);
	}
	if (indeterminate) {
		return unknown("a shared interface holds no address yet");
	}
	return OK;
}

/**
 * Foreign-table integrity.
 *
 * An ABSENT foreign table is `unknown`, deliberately: the ingest firewall is
 * operator-disable-able and is not provisioned on every image, so its absence is
 * a statement about the image rather than evidence that the steering layer
 * touched it. Only a table that IS installed and no longer matches its declared
 * hooks — or that now carries CeraLive client-flow rules — is degraded.
 */
export function checkForeignTables(
	nftRuleset: string | undefined,
): SharingDiagCheck {
	if (nftRuleset === undefined) {
		return unknown("`nft list ruleset` could not be read");
	}
	const tables = parseNftRuleset(nftRuleset);
	if (tables === null) return unknown("`nft list ruleset` was unparseable");

	const absent: string[] = [];
	for (const contract of FOREIGN_NFT_TABLES) {
		const table = findNftTable(tables, contract.family, contract.name);
		if (table === undefined) {
			absent.push(`${contract.family} ${contract.name}`);
			continue;
		}
		for (const hook of contract.hooks) {
			const chain = table.chains.find((entry) => entry.name === hook.chain);
			if (chain === undefined) {
				return degraded(
					"foreign_table_modified",
					`${contract.name} lost its ${hook.chain} chain`,
				);
			}
			if (chain.hook !== hook.hook || chain.priority !== hook.priority) {
				return degraded(
					"foreign_table_modified",
					`${contract.name} ${hook.chain} is hook ${chain.hook ?? "none"} priority ${chain.priority ?? "unresolved"}; expected hook ${hook.hook} priority ${hook.priority}`,
				);
			}
		}
		const intruded = table.chains.some((chain) =>
			chain.rules.some(
				(rule) =>
					rule.includes(SHARE_TABLE.name) || CLIENT_FLOW_MARK_RE.test(rule),
			),
		);
		if (intruded) {
			return degraded(
				"foreign_table_modified",
				`${contract.name} carries CeraLive client-flow rules`,
			);
		}
	}

	if (absent.length > 0) {
		return unknown(`${absent.join(", ")} is not installed`);
	}
	return OK;
}

/** `degraded` outranks `unknown` outranks `ok` — the rollup never over-claims. */
export function rollupSharingDiagState(
	checks: readonly SharingDiagCheck[],
): SharingDiagState {
	if (checks.some((check) => check.state === "degraded")) return "degraded";
	if (checks.some((check) => check.state === "unknown")) return "unknown";
	return "ok";
}

export function deriveSharingDiag(
	inputs: SharingDiagInputs,
	checkedAt: number,
): SharingDiag {
	const firewallBackend = checkFirewallBackend(inputs.firewallBackend);
	const steeringRules = checkSteeringRules(inputs.ipRuleShow);
	const sharedNat = checkSharedNat(inputs.nftRuleset, inputs.sharedZones);
	const foreignTables = checkForeignTables(inputs.nftRuleset);
	return {
		state: rollupSharingDiagState([
			firewallBackend,
			steeringRules,
			sharedNat,
			foreignTables,
		]),
		checkedAt,
		firewallBackend,
		steeringRules,
		sharedNat,
		foreignTables,
	};
}

function foreignMasqueradeRules(tables: readonly NftTable[]): string[] {
	const rules: string[] = [];
	for (const table of tables) {
		if (table.family === SHARE_TABLE.family && table.name === SHARE_TABLE.name)
			continue;
		for (const chain of table.chains) {
			for (const rule of chain.rules) {
				if (rule.includes("masquerade")) rules.push(rule);
			}
		}
	}
	return rules;
}
