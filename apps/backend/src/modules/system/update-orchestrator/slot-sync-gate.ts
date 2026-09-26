import type { UpdateCapabilities } from "@ceraui/rpc/schemas";
import type { OrchestratorPhase } from "./types.ts";

export type HealthySlotState = {
	readonly boot_id: string;
	readonly slot: string;
	readonly build_id: string;
	readonly dpkg_status_sha256: string;
	readonly recorded_at: string;
};

export type SlotSyncEvidence = {
	readonly healthyState: HealthySlotState | null;
	readonly bootId: string;
	readonly statusSha256: string;
	readonly buildId: string;
	readonly receiptStateSha256: string | null;
};

export type SlotSyncGateInput = SlotSyncEvidence & {
	readonly capabilities: UpdateCapabilities;
	readonly phase: OrchestratorPhase;
};

export type SlotSyncGate =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason:
				| "capability-absent"
				| "not-yet-booted"
				| "packages-changed"
				| "build-changed"
				| "already-synced"
				| "os-install-pending"
				| "update-busy"
				| "already-syncing";
	  };

/** Cheap pre-dispatch check, not the authority on live integrity. The unit
 * rechecks dpkg --audit, partlabel-guard, RAUC Operation and hawkBit under
 * BOTH nonblocking flocks. Duplicating those racy reads here would not close
 * the dispatch-to-execution window; exit 75 reports its authoritative refusal.
 * Lock-free here means no orchestrator-owned transaction phase is active;
 * external lockers are finally excluded by the unit's flock -n. */
export function slotSyncGate(input: SlotSyncGateInput): SlotSyncGate {
	if (
		input.capabilities.mode !== "capable" ||
		!input.capabilities.features.includes("slot-sync")
	)
		return { allowed: false, reason: "capability-absent" };
	if (
		!input.healthyState ||
		!input.bootId ||
		input.healthyState.boot_id !== input.bootId
	)
		return { allowed: false, reason: "not-yet-booted" };
	if (
		!input.statusSha256 ||
		input.healthyState.dpkg_status_sha256 !== input.statusSha256
	)
		return { allowed: false, reason: "packages-changed" };
	if (!input.buildId || input.healthyState.build_id !== input.buildId)
		return { allowed: false, reason: "build-changed" };
	if (input.receiptStateSha256 === input.statusSha256)
		return { allowed: false, reason: "already-synced" };
	if (
		["os-staging", "os-staged", "os-activation-armed", "os-verifying"].includes(
			input.phase,
		)
	)
		return { allowed: false, reason: "os-install-pending" };
	if (input.phase === "syncing")
		return { allowed: false, reason: "already-syncing" };
	if (
		[
			"awaiting-idle",
			"downloading",
			"committing",
			"restarting-services",
		].includes(input.phase)
	)
		return { allowed: false, reason: "update-busy" };
	return { allowed: true };
}
