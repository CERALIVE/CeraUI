/*
 * Captured-shape device output for the sharing-coexistence diagnostic.
 *
 * Every priority in these fixtures is DERIVED from the constants in
 * `uplink-steering/contracts.ts`, never typed as a literal: the whole point of
 * the ordering contract is that the two bands are non-overlapping and that the
 * steering band is numerically greater, and a fixture carrying `100`/`110` by
 * hand would keep asserting that after somebody changed the constants.
 */

import {
	CLIENT_FLOW_NAMESPACE,
	FOREIGN_NFT_TABLES,
	FWMARK_RULE_PRIORITY,
	SHARE_TABLE,
	SOURCE_ROUTE_RULE_PRIORITY,
	UPLINK_MARK_MASK,
} from "../modules/network/uplink-steering/contracts.ts";

export const SHARED_PREFIX = "10.42.0.0/24";
export const SECOND_SHARED_PREFIX = "192.168.99.0/24";

export function steeringMark(slot: number): number {
	return (CLIENT_FLOW_NAMESPACE | ((slot & 0xffff) << 8)) >>> 0;
}

function hex(value: number): string {
	return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

export interface IpRuleShowOptions {
	readonly steeringPriority?: number;
	readonly sourcePriority?: number;
	readonly steeringSlots?: readonly number[];
}

export function ipRuleShow(options: IpRuleShowOptions = {}): string {
	const steeringPriority = options.steeringPriority ?? FWMARK_RULE_PRIORITY;
	const sourcePriority = options.sourcePriority ?? SOURCE_ROUTE_RULE_PRIORITY;
	const slots = options.steeringSlots ?? [0x1a2b, 0x3c4d];
	const steering = slots.map(
		(slot) =>
			`${steeringPriority}:\tfrom all fwmark ${hex(steeringMark(slot))}/${hex(UPLINK_MARK_MASK)} lookup ${30000 + slot}`,
	);
	return [
		"0:\tfrom all lookup local",
		`${sourcePriority}:\tfrom 192.168.1.50 lookup 100`,
		`${sourcePriority}:\tfrom 10.20.30.40 lookup 120`,
		...steering,
		"32766:\tfrom all lookup main",
		"32767:\tfrom all lookup default",
		"",
	].join("\n");
}

const INGEST_FW = FOREIGN_NFT_TABLES[0];

export interface NftRulesetOptions {
	readonly sharedPrefixes?: readonly string[];
	readonly duplicateSharedPrefix?: string;
	readonly ingestFwPriority?: number | "absent";
	readonly ingestFwCarriesShareRule?: boolean;
	readonly includeShareTable?: boolean;
}

export function nftRuleset(options: NftRulesetOptions = {}): string {
	const prefixes = options.sharedPrefixes ?? [SHARED_PREFIX];
	const blocks: string[] = [];

	if (options.ingestFwPriority !== "absent") {
		const priority = options.ingestFwPriority ?? INGEST_FW.hooks[0].priority;
		const rules = [`\t\tudp dport 4001 accept`];
		if (options.ingestFwCarriesShareRule === true) {
			rules.push(`\t\tjump ${SHARE_TABLE.name}_input`);
		}
		blocks.push(
			[
				`table ${INGEST_FW.family} ${INGEST_FW.name} {`,
				`\tchain ${INGEST_FW.hooks[0].chain} {`,
				`\t\ttype filter hook ${INGEST_FW.hooks[0].hook} priority filter ${priority < 0 ? "-" : "+"} ${Math.abs(priority)}; policy accept;`,
				...rules,
				"\t}",
				"}",
			].join("\n"),
		);
	}

	for (const [index, prefix] of prefixes.entries()) {
		blocks.push(nmSharedTable(`wlan${index}`, prefix));
	}
	if (options.duplicateSharedPrefix !== undefined) {
		blocks.push(nmSharedTable("br-lan", options.duplicateSharedPrefix));
	}

	if (options.includeShareTable !== false) {
		blocks.push(
			[
				`table ${SHARE_TABLE.family} ${SHARE_TABLE.name} {`,
				"\tchain postrouting {",
				"\t\ttype nat hook postrouting priority srcnat; policy accept;",
				...prefixes.map(
					(prefix) =>
						`\t\tct mark and 0xff000000 == ${hex(CLIENT_FLOW_NAMESPACE)} ip saddr ${prefix} oifname "wwan0" masquerade`,
				),
				"\t}",
				"}",
			].join("\n"),
		);
	}

	return `${blocks.join("\n")}\n`;
}

function nmSharedTable(ifname: string, prefix: string): string {
	return [
		`table ip nm-shared-${ifname} {`,
		"\tchain nat_postrouting {",
		"\t\ttype nat hook postrouting priority srcnat; policy accept;",
		`\t\tip saddr ${prefix} ip daddr != ${prefix} masquerade`,
		"\t}",
		"\tchain filter_forward {",
		"\t\ttype filter hook forward priority filter; policy accept;",
		`\t\tip daddr ${prefix} oifname "${ifname}" ct state { established, related } accept`,
		"\t}",
		"}",
	].join("\n");
}
