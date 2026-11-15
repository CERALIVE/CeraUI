import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import type { nmConnSetFields } from "../network/network-manager.ts";
import type { AdapterModeOutcomePublisher } from "./wifi-adapter-mode-outcome.ts";
import type { HotspotStopResult } from "./wifi-hotspot-config.ts";
import type { HotspotStartResult } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import type { RadioIdentity } from "./wifi-radio-identity.ts";

export type WifiPolicyObservation = {
	readonly identities: ReadonlyMap<string, RadioIdentity>;
	readonly active: Map<string | undefined, string | null>;
	readonly station?: boolean;
	readonly write?: typeof nmConnSetFields;
};

export type WifiRestoreEdge = {
	readonly row: WifiInterface;
	readonly desired: string | undefined;
	readonly signature: string;
	readonly completed: boolean;
	readonly attempts: number;
	readonly discovery: number;
	readonly attempt?: object;
	readonly retryAfter?: number;
};

export type WifiRestoreCycle = {
	readonly edges: Map<string, WifiRestoreEdge>;
	readonly stopped: () => boolean;
};

export type WifiRestoreRequest = {
	readonly row: WifiInterface;
	readonly desired: string | undefined;
	readonly signature: string;
	readonly cycle?: WifiRestoreCycle;
	readonly isCurrent?: () => boolean;
	readonly activate: (
		settle: (confirmed: boolean) => void,
	) => Promise<HotspotStartResult | undefined>;
};

export type WifiModeReconcileRequest = {
	readonly row: WifiInterface;
	readonly target: WifiAdapterMode;
	readonly publish: AdapterModeOutcomePublisher;
	readonly publishPending: () => void;
	readonly start: () => Promise<HotspotStartResult>;
	readonly stop: (terminal: boolean) => Promise<HotspotStopResult>;
};
