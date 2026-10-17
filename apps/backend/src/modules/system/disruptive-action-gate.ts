import type { OrchestratorPhase } from "./update-orchestrator/types.ts";

export type StreamLiveness = "streaming" | "idle" | "unknown";
export type UpdateBusyReason =
	| "package-install"
	| "downloading"
	| "committing"
	| "restarting-services"
	| "os-staging"
	| "syncing"
	| "os-activation"
	| "pending-success"
	| "pending-durability"
	| "update-recovery"
	| "maintenance";
export interface DisruptiveActionEvidence {
	readonly streamLiveness: StreamLiveness;
	readonly updateBusy: readonly UpdateBusyReason[];
}
export interface DisruptiveActionSource {
	readonly read: () => DisruptiveActionEvidence;
}
export type DisruptiveActionDecision =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason:
				| "streaming"
				| "stream_liveness_unknown"
				| "update_in_progress";
	  };

export function decideDisruptiveAction(
	evidence: DisruptiveActionEvidence,
): DisruptiveActionDecision {
	switch (evidence.streamLiveness) {
		case "streaming":
			return { allowed: false, reason: "streaming" };
		case "unknown":
			return { allowed: false, reason: "stream_liveness_unknown" };
		case "idle":
			break;
		default:
			return assertNever(evidence.streamLiveness);
	}
	return evidence.updateBusy.length > 0
		? { allowed: false, reason: "update_in_progress" }
		: { allowed: true };
}

export function updatePhaseBusyReasons(
	phase: OrchestratorPhase,
): readonly UpdateBusyReason[] {
	switch (phase) {
		case "downloading":
			return ["downloading"];
		case "committing":
			return ["committing"];
		case "restarting-services":
			return ["restarting-services"];
		case "os-staging":
			return ["os-staging"];
		case "syncing":
			return ["syncing"];
		case "idle":
		case "checking":
		case "available":
		case "awaiting-idle":
		case "settled":
		case "os-available":
		case "os-staged":
		case "os-activation-armed":
		case "os-verifying":
		case "sync-eligible":
		case "synced":
		case "quarantined":
		case "failed":
			return [];
		default:
			return assertNever(phase);
	}
}

function assertNever(value: never): never {
	throw new TypeError(
		`Unexpected disruptive-action evidence: ${String(value)}`,
	);
}
