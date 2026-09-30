import { createHash } from "node:crypto";
import { z } from "zod";
import { readBootId } from "./os-agent.ts";
import type {
	HealthySlotState,
	ReceiptTarget,
	SlotSyncEvidence,
} from "./slot-sync-gate.ts";

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

const ROOTFS_SECTION = /^\[\s*slot\.(rootfs\.\d+)\s*\]$/;
const ANY_SECTION = /^\[.*\]$/;
// GLib key files allow whitespace around `=`, so `bootname = A` is valid.
const BOOTNAME_KEY = /^bootname\s*=\s*(.*)$/;
const NAMED_SLOT = /^[A-Za-z0-9_-]+\.\d+$/;

/** RAUC rootfs slot name -> bootname, from `[slot.rootfs.<n>]` `bootname`. */
export function parseRaucSlotBootnames(
	systemConf: string,
): ReadonlyMap<string, string> {
	const bootnames = new Map<string, string>();
	let slot: string | null = null;
	for (const raw of systemConf.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("#") || line.startsWith(";")) continue;
		if (ANY_SECTION.test(line)) {
			slot = ROOTFS_SECTION.exec(line)?.[1] ?? null;
			continue;
		}
		const bootname = BOOTNAME_KEY.exec(line)?.[1]?.trim();
		if (slot && bootname) bootnames.set(slot, bootname);
	}
	return bootnames;
}

type SyncReceipt = z.infer<typeof syncReceiptSchema>;

/**
 * Which slot the receipt records a mirror INTO, relative to the slot booted
 * now. An OS activation swaps the booted slot without touching dpkg, so a
 * receipt whose SHA still matches can describe the mirror into the slot we now
 * run from (task-45d OPI D1). Identity comes only from this boot's healthy
 * record and the static system.conf bootname map, never from timestamps: a
 * clock can step, and a completion time says nothing about which slot was
 * written. `unknown` means the booted slot cannot be resolved, or the target
 * is a name the map lacks that could be the other rootfs slot; the gate then
 * neither suppresses nor dispatches the mirror, and the poll lets RAUC decide.
 */
export function classifyReceiptTarget(input: {
	readonly receipt: Pick<SyncReceipt, "target_slot"> | null;
	readonly healthyState: HealthySlotState | null;
	readonly bootId: string;
	readonly bootnames: ReadonlyMap<string, string>;
}): ReceiptTarget {
	const { receipt, healthyState, bootId, bootnames } = input;
	if (!receipt) return "not-other";
	// A previous boot's record names the slot booted THEN, which an
	// activation or fallback may since have swapped.
	if (!healthyState || !bootId || healthyState.boot_id !== bootId)
		return "unknown";
	if (receipt.target_slot === healthyState.slot) return "not-other";
	const known = new Set(bootnames.values());
	const bootnameOf = (slot: string): string | null =>
		bootnames.get(slot) ?? (known.has(slot) ? slot : null);
	const booted = bootnameOf(healthyState.slot);
	if (booted === null) return "unknown";
	const target = bootnameOf(receipt.target_slot);
	if (target !== null) return target !== booted ? "other" : "not-other";
	// An unmapped name is ruled out only when it provably cannot be the other
	// rootfs slot: the map already names that slot, or the name is a RAUC slot
	// of another class (`certs.0`). Otherwise a partial map would turn a real
	// mirror's own receipt into `not-other` and the mirror would fail.
	const otherSlotMapped = [...known].some((name) => name !== booted);
	const otherClassSlot =
		NAMED_SLOT.test(receipt.target_slot) &&
		!receipt.target_slot.startsWith("rootfs.");
	return otherSlotMapped || otherClassSlot ? "not-other" : "unknown";
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
		receiptTarget: classifyReceiptTarget({
			receipt,
			healthyState,
			bootId,
			bootnames: parseRaucSlotBootnames(systemConf),
		}),
		receiptTargetSlot: receipt?.target_slot ?? null,
	};
}
