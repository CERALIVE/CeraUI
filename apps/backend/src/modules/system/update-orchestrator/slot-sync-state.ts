import { createHash } from "node:crypto";
import { z } from "zod";
import { readBootId } from "./os-agent.ts";
import type { SlotSyncEvidence } from "./slot-sync-gate.ts";

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

export async function readSlotSyncEvidence(): Promise<SlotSyncEvidence> {
	const healthyFile = Bun.file(HEALTHY_STATE_FILE);
	const receiptFile = Bun.file(SYNC_RECEIPT_FILE);
	const [bootId, bytes, osRelease, healthyState, receipt] = await Promise.all([
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
	};
}
