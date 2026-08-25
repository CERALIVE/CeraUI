import { UPLINK_MARK_MASK } from "../uplink-steering/contracts.ts";

export const SHAPER_CONFIG = {
	tickMs: 5_000,
	floorBps: 1_000_000,
	ceilingBps: 20_000_000,
	bootstrapCapBps: 4_000_000,
	additiveStepBps: 500_000,
	multiplicativeDecrease: 0.7,
	rttInflationRatio: 1.35,
	baselineEwmaAlpha: 0.15,
	backlogThresholdBytes: 32_768,
	backlogCongestedTicks: 2,
	rootHandle: "ca00:",
	clientHandle: "ca20:",
	clientClassId: "ca20:1",
	markMask: UPLINK_MARK_MASK,
} as const;

export const SHAPER_OWNERSHIP_PATH =
	"/run/ceralive/uplink-shaper-roots.json" as const;

export type ShaperMode = "idle" | "streaming";
export type ShaperAlgorithm = "cake" | "htb-fq_codel";

export interface SharedShaperUplink {
	readonly identity: string;
	readonly ifname: string;
	readonly mark: number;
}

export interface ShapedUplink {
	readonly ifname: string;
	readonly mark: number;
	readonly capBps: number;
}

export interface ShaperApplyRequest {
	readonly mode: ShaperMode;
	readonly uplinks: readonly ShapedUplink[];
}

export interface ShaperTelemetry {
	readonly iface: string;
	readonly rttMs: number;
	readonly nakCount: number;
	readonly stale: boolean;
}

export interface ShaperUpdate {
	readonly streaming: boolean;
	readonly sharedUplinks: readonly SharedShaperUplink[];
	readonly telemetry: readonly ShaperTelemetry[];
}

export type ShaperUnavailableReason =
	| "foreign_qdisc"
	| "qdisc_inventory_failed"
	| "tc_apply_failed";

export class ShaperUnavailableError extends Error {
	readonly reason: ShaperUnavailableReason;

	constructor(reason: ShaperUnavailableReason, detail?: string) {
		super(detail ?? reason);
		this.name = "ShaperUnavailableError";
		this.reason = reason;
	}
}
