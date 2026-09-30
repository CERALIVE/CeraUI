import type { RootSlotStatus } from "../../modules/system/update-orchestrator/slot-status.ts";

const SLOT_NAMES = { A: "rootfs.0", B: "rootfs.1" } as const;

/**
 * Rootfs slots as `rauc status` reports them once the mirror from the booted
 * slot has finished: the other slot inactive and marked `otherStatus`.
 */
export function raucSlots(
	booted: "A" | "B",
	otherStatus = "good",
): readonly RootSlotStatus[] {
	const other = booted === "A" ? "B" : "A";
	const slot = (
		bootname: "A" | "B",
		state: string,
		bootStatus: string,
	): RootSlotStatus => ({
		name: SLOT_NAMES[bootname],
		bootname,
		state,
		bootStatus,
		version: null,
		lastSyncedAt: null,
	});
	return [slot(booted, "booted", "good"), slot(other, "inactive", otherStatus)];
}
