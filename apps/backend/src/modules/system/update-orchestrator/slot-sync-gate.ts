import type { UpdateCapabilities } from "@ceraui/rpc/schemas";
import type { RootSlotStatus } from "./slot-status.ts";
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
	// The receipt names the slot that is not booted now; see
	// receiptTargetsOtherSlot() for why the SHA alone is not enough.
	readonly receiptTargetsOtherSlot: boolean;
	readonly receiptTargetSlot: string | null;
};

/** The unit's receipt records a mirror of THIS dpkg state into the CURRENT
 * other slot. */
export function receiptConfirmsMirror(evidence: SlotSyncEvidence): boolean {
	return (
		evidence.receiptStateSha256 === evidence.statusSha256 &&
		evidence.receiptTargetsOtherSlot
	);
}

export type MirrorTargetVerdict = "good" | "bad" | "not-target" | "undecidable";

/**
 * Whether RAUC confirms the mirror the receipt describes. The unit writes the
 * receipt, then runs `rauc status mark-good other`, then exits, so a finished
 * run leaves the inactive slot `good`; a receipt that survived a power loss
 * between the first two steps leaves it `bad`. Anything RAUC does not state
 * plainly (not exactly one booted and one inactive rootfs slot, or another
 * boot status) is undecidable.
 */
export function judgeMirrorTarget(
	slots: readonly Pick<
		RootSlotStatus,
		"name" | "bootname" | "state" | "bootStatus"
	>[],
	receiptTargetSlot: string | null,
): MirrorTargetVerdict {
	const booted = slots.filter((slot) => slot.state === "booted");
	const [inactive, ...moreInactive] = slots.filter(
		(slot) => slot.state === "inactive",
	);
	if (
		slots.length !== 2 ||
		booted.length !== 1 ||
		!inactive ||
		moreInactive.length > 0
	)
		return "undecidable";
	if (
		receiptTargetSlot === null ||
		(receiptTargetSlot !== inactive.name &&
			receiptTargetSlot !== inactive.bootname)
	)
		return "not-target";
	if (inactive.bootStatus === "good") return "good";
	if (inactive.bootStatus === "bad") return "bad";
	return "undecidable";
}

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
	if (receiptConfirmsMirror(input))
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
