import type { SlotSyncProbeState } from "./lock.ts";
import type { RootSlotStatus } from "./slot-status.ts";
import {
	judgeMirrorTarget,
	receiptConfirmsMirror,
	type SlotSyncEvidence,
} from "./slot-sync-gate.ts";

export function isRecordedSyncFailure(reason: string | null): boolean {
	return (
		reason === "slot-sync-incomplete" ||
		reason === "slot-sync-unit-absent" ||
		/^slot-sync (?:failed|refused) \(exit [1-9][0-9]{0,2}\)$/.test(reason ?? "")
	);
}

export function syncUnitClean(probe: SlotSyncProbeState): boolean {
	switch (probe.kind) {
		case "inactive-clean":
		case "succeeded":
			return true;
		case "absent":
		case "running":
		case "failed":
		case "refused":
			return false;
		default: {
			const unreachable: never = probe;
			return unreachable;
		}
	}
}

export function laterSyncProven(input: {
	readonly evidence: SlotSyncEvidence;
	readonly slots: readonly RootSlotStatus[];
	readonly version: string | undefined;
	readonly failureAt: number;
	readonly now: number;
}): boolean {
	const { evidence, slots } = input;
	const completed = evidence.receiptCompletedAt
		? Date.parse(evidence.receiptCompletedAt)
		: NaN;
	const booted = slots.find((slot) => slot.state === "booted");
	return (
		Number.isFinite(completed) &&
		completed > input.failureAt &&
		completed <= input.now &&
		receiptConfirmsMirror(evidence) &&
		evidence.buildId !== "" &&
		evidence.receiptBuildId === evidence.buildId &&
		input.version !== undefined &&
		input.version !== "" &&
		evidence.receiptImageVersion === input.version &&
		evidence.bootId !== "" &&
		evidence.healthyState?.boot_id === evidence.bootId &&
		(evidence.healthyState.slot === booted?.name ||
			evidence.healthyState.slot === booted?.bootname) &&
		judgeMirrorTarget(slots, evidence.receiptTargetSlot) === "good" &&
		slots.every((slot) => slot.bootStatus === "good")
	);
}
