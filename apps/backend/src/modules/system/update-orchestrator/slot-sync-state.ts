import { createHash } from "node:crypto";
import { z } from "zod";
import { readBootId } from "./os-agent.ts";
import type { HealthySlotState, SlotSyncEvidence } from "./slot-sync-gate.ts";

export const SYNC_RECEIPT_FILE =
	"/data/ceralive/update-state/sync-receipt.json";
const HEALTHY_STATE_FILE = "/data/ceralive/update-state/healthy-state.json";
const healthyStateSchema = z
	.object({
		boot_id: z.string().min(1),
		slot: z.string().min(1),
		build_id: z.string().min(1),
		dpkg_status_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		recorded_at: z.string().min(1),
	})
	.strict();
export const syncReceiptSchema = z
	.object({
		state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		build_id: z.string(),
		image_version: z.string(),
		target_slot: z.string(),
		completed_at: z.string(),
	})
	.strict();

export function buildIdFromOsRelease(
	osRelease: string,
	fallback: string,
): string {
	const buildId =
		osRelease
			.split("\n")
			.find((line) => line.startsWith("BUILD_ID="))
			?.slice("BUILD_ID=".length)
			.replaceAll('"', "") ?? "";
	return buildId || fallback.replaceAll("\n", "");
}

const RAUC_SYSTEM_CONF = "/etc/rauc/system.conf";

/** RAUC slot name -> bootname, from `[slot.<name>]` sections with `bootname=`. */
export function parseRaucSlotBootnames(
	systemConf: string,
): ReadonlyMap<string, string> {
	const bootnames = new Map<string, string>();
	let slot: string | null = null;
	for (const raw of systemConf.split("\n")) {
		const line = raw.trim();
		const section = /^\[(.+)\]$/.exec(line)?.[1];
		if (section !== undefined) {
			slot = section.startsWith("slot.") ? section.slice("slot.".length) : null;
			continue;
		}
		if (slot && line.startsWith("bootname="))
			bootnames.set(slot, line.slice("bootname=".length).trim());
	}
	return bootnames;
}

type SyncReceipt = z.infer<typeof syncReceiptSchema>;

/**
 * Whether the receipt records a mirror INTO the slot that is not booted now.
 * An OS activation swaps the booted slot without touching dpkg, so a receipt
 * whose SHA still matches can describe the mirror into the slot we now run
 * from (task-45d OPI D1). Undecidable reads answer false, which lets the
 * mirror run: an unneeded mirror re-copies a healthy slot under the unit's own
 * gates, while a skipped one leaves a stale fallback. The receipt the unit
 * then writes this boot ends the repeat even without a slot map, because the
 * unit refuses to run before this boot's healthy record exists.
 */
export function receiptTargetsOtherSlot(input: {
	readonly receipt: Pick<SyncReceipt, "target_slot" | "completed_at"> | null;
	readonly healthyState: HealthySlotState | null;
	readonly bootId: string;
	readonly bootnames: ReadonlyMap<string, string>;
}): boolean {
	const { receipt, healthyState, bootId, bootnames } = input;
	// A previous boot's record names the slot booted THEN, which an
	// activation or fallback may since have swapped.
	if (!receipt || !healthyState || !bootId || healthyState.boot_id !== bootId)
		return false;
	if (receipt.target_slot === healthyState.slot) return false;
	const known = new Set(bootnames.values());
	const bootnameOf = (slot: string): string | null =>
		bootnames.get(slot) ?? (known.has(slot) ? slot : null);
	const target = bootnameOf(receipt.target_slot);
	const booted = bootnameOf(healthyState.slot);
	if (target !== null && booted !== null) return target !== booted;
	const completedAt = Date.parse(receipt.completed_at);
	const bootRecordedAt = Date.parse(healthyState.recorded_at);
	return (
		Number.isFinite(completedAt) &&
		Number.isFinite(bootRecordedAt) &&
		completedAt >= bootRecordedAt
	);
}

export async function readSlotSyncEvidence(): Promise<SlotSyncEvidence> {
	const healthyFile = Bun.file(HEALTHY_STATE_FILE);
	const receiptFile = Bun.file(SYNC_RECEIPT_FILE);
	const [bootId, bytes, osRelease, healthyState, receipt, systemConf] =
		await Promise.all([
			readBootId(),
			Bun.file("/var/lib/dpkg/status").arrayBuffer(),
			Bun.file("/etc/os-release")
				.text()
				.catch(() => ""),
			healthyFile
				.exists()
				.then(async (exists) =>
					exists ? healthyStateSchema.parse(await healthyFile.json()) : null,
				),
			receiptFile
				.exists()
				.then(async (exists) =>
					exists ? syncReceiptSchema.parse(await receiptFile.json()) : null,
				),
			Bun.file(RAUC_SYSTEM_CONF)
				.text()
				.catch(() => ""),
		]);
	// SHA-256 of the exact dpkg status bytes, like the image's sha256sum.
	const statusSha256 = createHash("sha256")
		.update(new Uint8Array(bytes))
		.digest("hex");
	// Mirror the image script: first BUILD_ID= line, remove quotes; only if empty
	// fall back to image-build-commit with newlines removed.
	const fromRelease = buildIdFromOsRelease(osRelease, "");
	const fallback = fromRelease
		? ""
		: await Bun.file("/etc/ceralive/image-build-commit")
				.text()
				.then((value) => value.replaceAll("\n", ""))
				.catch(() => "");
	return {
		healthyState,
		bootId,
		statusSha256,
		buildId: buildIdFromOsRelease(osRelease, fallback),
		receiptStateSha256: receipt?.state_sha256 ?? null,
		receiptTargetsOtherSlot: receiptTargetsOtherSlot({
			receipt,
			healthyState,
			bootId,
			bootnames: parseRaucSlotBootnames(systemConf),
		}),
		receiptTargetSlot: receipt?.target_slot ?? null,
	};
}
