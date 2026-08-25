import type { SteeringUnavailableReason } from "@ceraui/rpc/schemas";

export type {
	SteeringUnavailableReason,
	UplinkFlowsResetEvent,
	UplinkSteeringStatus,
} from "@ceraui/rpc/schemas";

export const SHARE_SERVICE = "ceralive-share.service" as const;
export const SHARE_RULESET_PATH = "/run/ceralive/share.nft" as const;
export const SHARE_TABLE = {
	family: "inet",
	name: "ceralive_share",
} as const;

export const FOREIGN_NFT_TABLES = [
	{
		family: "inet",
		name: "ceralive_ingest_fw",
		hooks: [{ chain: "input", hook: "input", priority: -10 }],
	},
] as const;

/** Existing source-routing rules use priority 100; steering must run later. */
export const SOURCE_ROUTE_RULE_PRIORITY = 100 as const;
export const FWMARK_RULE_PRIORITY = 110 as const;

/** Fixed random space; largest-remainder apportionment fills every bucket. */
export const WEIGHT_BUCKET_MODULUS = 10_000 as const;
export const MAX_STEERING_WEIGHT = 100 as const;
export const MAX_STEERING_UPLINKS = 6 as const;

/**
 * Packet/conntrack mark layout:
 *
 *   0xca | deterministic 16-bit uplink id | 8 bits left to other consumers
 *
 * The top byte proves that a conntrack entry originated in a CeraLive client
 * zone. The top 24 bits select the uplink route without clobbering the low byte.
 */
export const CLIENT_FLOW_NAMESPACE = 0xca000000;
export const CLIENT_FLOW_NAMESPACE_MASK = 0xff000000;
export const UPLINK_MARK_MASK = 0xffffff00;
export const UNOWNED_MARK_MASK = 0x000000ff;

export interface ClientZone {
	readonly ifname: string;
	readonly ipv4Cidr: string;
}

export interface SteeringUplink {
	readonly identity: string;
	readonly ifname: string;
	readonly mark: number;
	readonly selectable: boolean;
	readonly weight: number;
}

export interface ShareRulesetState {
	readonly clientZones: readonly ClientZone[];
	readonly uplinks: readonly SteeringUplink[];
}

export type SteeringAvailability =
	| { readonly available: true }
	| {
			readonly available: false;
			readonly reason: SteeringUnavailableReason;
			readonly detail?: string;
	  };

export class SteeringUnavailableError extends Error {
	readonly reason: SteeringUnavailableReason;

	constructor(reason: SteeringUnavailableReason, detail?: string) {
		super(detail ?? reason);
		this.name = "SteeringUnavailableError";
		this.reason = reason;
	}
}
