import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SYNC_RECEIPT_FILE, syncReceiptSchema } from "./slot-sync-state.ts";

const raucSlotSchema = z.object({
	class: z.string(),
	bootname: z.string().optional(),
	state: z.string(),
	boot_status: z.string().optional(),
	bundle: z.object({ version: z.string().optional() }).optional(),
	installed: z.object({ timestamp: z.string().optional() }).optional(),
});
const raucStatusSchema = z.object({
	slots: z.array(z.record(z.string(), raucSlotSchema)),
});

export type RootSlotStatus = {
	readonly name: string;
	readonly bootname: string | null;
	readonly state: string;
	readonly bootStatus: string | null;
	readonly version: string | null;
	readonly lastSyncedAt: string | null;
};

/** Internal read seam for Todo 41. Never widens the S1-locked raucSlot scalar. */
export function parseBothSlotStatus(
	stdout: string,
	receipt: unknown,
): RootSlotStatus[] {
	const parsed = raucStatusSchema.parse(JSON.parse(stdout));
	const validReceipt = syncReceiptSchema.safeParse(receipt);
	return parsed.slots.flatMap((item) =>
		Object.entries(item).flatMap(([name, slot]) => {
			if (slot.class !== "rootfs") return [];
			const mirror =
				validReceipt.success &&
				(validReceipt.data.target_slot === name ||
					validReceipt.data.target_slot === slot.bootname) &&
				(!slot.installed?.timestamp ||
					(Number.isFinite(Date.parse(slot.installed.timestamp)) &&
						Date.parse(slot.installed.timestamp) <=
							Date.parse(validReceipt.data.completed_at)))
					? validReceipt.data
					: null;
			return [
				{
					name,
					bootname: slot.bootname ?? null,
					state: slot.state,
					bootStatus: slot.boot_status ?? null,
					version: mirror?.image_version || slot.bundle?.version || null,
					lastSyncedAt: mirror?.completed_at ?? null,
				},
			];
		}),
	);
}

export async function readBothSlotStatus(
	run: typeof spawnWithTimeout = spawnWithTimeout,
): Promise<RootSlotStatus[]> {
	const result = await run(
		["rauc", "status", "--detailed", "--output-format=json"],
		{ timeoutMs: 10_000 },
	);
	if (result.exitCode !== 0) throw new Error("rauc status failed");
	const file = Bun.file(SYNC_RECEIPT_FILE);
	const receipt = (await file.exists()) ? await file.json() : null;
	return parseBothSlotStatus(result.stdout, receipt);
}
