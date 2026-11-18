import { uptime } from "node:os";
import { logger } from "../../helpers/logger.ts";
import { ID_RE } from "../../helpers/run.ts";
import { concurrentApIfname } from "./wifi-interface-creation.ts";
import type { RadioLifetime } from "./wifi-radio-identity.ts";

export type HybridTargetReason =
	| "admission-lost"
	| "admission-lost-after-parent-sample"
	| "admission-lost-after-combination"
	| "admission-lost-after-profile-check"
	| "radio-unqualified"
	| "boot-id-unavailable"
	| "discovery-boot-mismatch"
	| "parent-sample-unavailable"
	| "parent-identity-mismatch"
	| "creation-disabled"
	| "target-phy-mismatch"
	| "target-witness-mismatch"
	| "retained-target-changed"
	| "p2p-not-idle"
	| "unnamed-phy-interface"
	| "parent-role-mismatch"
	| "target-role-mismatch"
	| "peer-flags-unavailable"
	| "peer-interface-up"
	| "parent-not-in-iw"
	| "target-iw-identity-mismatch"
	| "first-wireless-observation-unavailable"
	| "first-wireless-witness-mismatch"
	| "interface-combination-refused"
	| "existing-target-not-idle"
	| "existing-target-has-stations"
	| "profile-ownership-unproven"
	| "target-allocation-failed"
	| "target-allocation-origin-mismatch"
	| "allocated-target-not-ready"
	| "borrowed-target-changed"
	| "created-target-changed"
	| "target-changed-before-policy"
	| "target-autoconnect-refused"
	| "target-changed-after-policy"
	| "target-allocation-unreported"
	| "station-channel-unavailable"
	| "limited-hybrid-revalidation-failed";

type WirelessEvidence = {
	readonly ifindex?: string | undefined;
	readonly wdev?: string | undefined;
	readonly wiphy?: number | undefined;
};

export type HybridLegIdentity = ReturnType<typeof hybridLegIdentity>;

export function hybridLegIdentity(
	name: string | undefined,
	lifetime: RadioLifetime | undefined,
	wireless: WirelessEvidence | undefined,
	wirelessStatus: "not-read" | "pending" | "unavailable" | "observed" = wireless
		? "observed"
		: "not-read",
) {
	return {
		name: name && ID_RE.test(name) ? name : null,
		ifindex:
			lifetime?.ifindex ??
			(wireless?.ifindex ? Number(wireless.ifindex) : null),
		wiphy: wireless?.wiphy ?? lifetime?.wiphy ?? null,
		wdev: wireless?.wdev ?? null,
		phyPath: lifetime?.phyPath ?? null,
		iwIfindex: wireless?.ifindex ? Number(wireless.ifindex) : null,
		iwWiphy: wireless?.wiphy ?? null,
		wirelessStatus,
	};
}

export function hybridIwLegIdentity(
	info: string,
	lifetime?: RadioLifetime,
): HybridLegIdentity {
	const wiphy = /^\s*wiphy\s+(\d+)\s*$/m.exec(info)?.[1];
	return hybridLegIdentity(
		/^\s*Interface\s+(\S+)\s*$/m.exec(info)?.[1],
		lifetime,
		{
			ifindex: /^\s*ifindex\s+(\d+)\s*$/m.exec(info)?.[1],
			wdev: /^\s*wdev\s+(0x[0-9a-f]+)\s*$/im.exec(info)?.[1],
			wiphy: wiphy === undefined ? undefined : Number(wiphy),
		},
		info ? "observed" : "unavailable",
	);
}

export type HybridChannelEvidence = {
	stationAssociated: boolean | null;
	frequencyBand: "2.4" | "5" | "6" | "other" | null;
	channelPermitted: boolean | null;
};

export function hybridFrequencyBand(
	frequency: number,
): HybridChannelEvidence["frequencyBand"] {
	if (!Number.isFinite(frequency)) return null;
	if (frequency >= 2400 && frequency < 2500) return "2.4";
	if (frequency >= 4900 && frequency < 5925) return "5";
	if (frequency >= 5925 && frequency <= 7125) return "6";
	return "other";
}

export type HybridQualificationFailure =
	| "unqualified-band"
	| "radio-unqualified"
	| "unclassified";

export type HybridChannelSubReason =
	| "parent-sample-unavailable"
	| "parent-identity-mismatch"
	| "not-associated"
	| "station-connection-unavailable"
	| "station-link-mismatch"
	| "interface-combination-refused"
	| "regulatory-evidence-unavailable"
	| "no-permitting-regulatory-rule"
	| "dfs-or-no-ir"
	| "ap-channel-unavailable"
	| "station-identity-changed"
	| "channel-read-failed"
	| HybridQualificationFailure;

export type HybridChannelRefusal = Readonly<HybridChannelEvidence> & {
	readonly subReason: HybridChannelSubReason;
};

export type AllocationFailure =
	| "admission-lost-before-lookup"
	| "admission-lost-after-lookup"
	| "borrowed-role-not-managed"
	| "admission-lost-after-borrowed-wait"
	| "borrowed-nm-not-visible"
	| "create-forbidden"
	| "create-command-failed"
	| "creation-receipt-unavailable"
	| "admission-lost-after-create"
	| "created-identity-query-failed"
	| "created-identity-mismatch"
	| "admission-lost-after-created-wait"
	| "created-nm-not-visible"
	| "created-identity-changed-after-wait"
	| "creation-permit-refused"
	| "created-autoconnect-refused"
	| "admission-lost-after-created-autoconnect"
	| "allocation-read-or-write-failed";

export type SelectorSubReason =
	| "parent-lifetime-unavailable"
	| "parent-lifetime-mismatch"
	| "permanent-mac-mismatch"
	| "stored-boot-mismatch"
	| "live-target-unavailable"
	| "stored-lifetime-mismatch"
	| "target-missing-in-iw"
	| "iw-ifindex-mismatch"
	| "iw-wdev-unavailable"
	| "target-sample-unavailable"
	| "target-wireless-identity-unavailable"
	| "target-autoconnect-unavailable"
	| "allocated-target-not-idle"
	| "allocator-unreported";

type LimitedRevalidationSubReason =
	| "admission-lost"
	| "target-no-longer-valid"
	| "station-channel-changed";

type HybridDiagnosticPath = "activation" | "limited-restore" | "operator-start";

export function hybridDiagnosticTime() {
	return {
		processElapsedMs: Math.round(process.uptime() * 1000),
		bootUptimeSeconds: uptime(),
	};
}

export type HybridRestoreAttempt = {
	readonly attempt: number;
	readonly maxAttempts: number;
};

export type HybridTargetFacts = {
	targetListed: boolean | null;
	targetSampled: boolean | null;
	qualified: boolean | null;
	samePermanentMac: boolean | null;
	samePhysicalPath: boolean | null;
	profileOwnership: boolean | null;
};

export type HybridTargetRefusal = Readonly<HybridTargetFacts> & {
	readonly reasonCode: HybridTargetReason;
	readonly subReason?:
		| AllocationFailure
		| SelectorSubReason
		| HybridChannelSubReason
		| LimitedRevalidationSubReason
		| "channel-read-unreported";
	readonly witness?: HybridLegIdentity;
	readonly observed?: HybridLegIdentity;
	readonly targetAutoconnect?: "yes" | "no" | "unavailable";
	readonly targetNmState?: number | null;
	readonly targetNmManaged?: boolean | null;
	readonly targetHasActiveConnection?: boolean | null;
	readonly p2pNmState?: number | null;
	readonly p2pCount?: number;
	readonly peerIfname?: string | null;
};

export const unreadHybridTargetFacts: Readonly<HybridTargetFacts> = {
	targetListed: null,
	targetSampled: null,
	qualified: null,
	samePermanentMac: null,
	samePhysicalPath: null,
	profileOwnership: null,
};

export function nmStateCode(value: string | undefined): number | null {
	const state = value?.match(/^\d+/)?.[0];
	return state === undefined ? null : Number(state);
}

export function logHybridTargetRefusal(
	message: string,
	parentIfname: string,
	path: HybridDiagnosticPath,
	stationAssociated: boolean | null,
	attempt: HybridRestoreAttempt | undefined,
	refusal: HybridTargetRefusal | undefined,
	channel?: HybridChannelEvidence,
): void {
	logger.warn(message, {
		event: "wifi-hybrid-target-refused",
		path,
		parentIfname,
		targetIfname: concurrentApIfname(parentIfname),
		stationAssociated,
		attempt: attempt?.attempt ?? null,
		maxAttempts: attempt?.maxAttempts ?? null,
		...hybridDiagnosticTime(),
		...channel,
		...(refusal ?? {
			reasonCode: "target-allocation-unreported" satisfies HybridTargetReason,
			...unreadHybridTargetFacts,
		}),
	});
}

export function logHybridChannelRefusal(
	message: string,
	parentIfname: string,
	path: HybridDiagnosticPath,
	attempt: HybridRestoreAttempt | undefined,
	refusal: HybridChannelRefusal | undefined,
	revalidation?: {
		readonly subReason: LimitedRevalidationSubReason;
		readonly initialFrequency: number | undefined;
		readonly observedFrequency?: number | undefined;
	},
): void {
	const frequency =
		revalidation?.observedFrequency ?? revalidation?.initialFrequency;
	const channel: HybridChannelEvidence & {
		readonly subReason:
			| HybridChannelSubReason
			| LimitedRevalidationSubReason
			| "channel-read-unreported";
	} = refusal ?? {
		stationAssociated: frequency === undefined ? null : true,
		frequencyBand:
			frequency === undefined ? null : hybridFrequencyBand(frequency),
		channelPermitted: frequency === undefined ? null : true,
		subReason: revalidation?.subReason ?? "channel-read-unreported",
	};
	logHybridTargetRefusal(
		message,
		parentIfname,
		path,
		channel.stationAssociated,
		attempt,
		{
			...unreadHybridTargetFacts,
			reasonCode: revalidation
				? "limited-hybrid-revalidation-failed"
				: "station-channel-unavailable",
			subReason: channel.subReason,
		},
		{
			stationAssociated: channel.stationAssociated,
			frequencyBand: channel.frequencyBand,
			channelPermitted: channel.channelPermitted,
		},
	);
}
