import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SYNC_RECEIPT_FILE, syncReceiptSchema } from "./slot-sync-state.ts";

const slotContentSchema = {
	bundle: z.object({ version: z.string().nullish() }).nullish(),
	installed: z.object({ timestamp: z.string().nullish() }).nullish(),
	activated: z.object({ timestamp: z.string().nullish() }).nullish(),
};
// RAUC 1.15 reports a non-bootable slot (certs.0) with null bootname and
// boot_status, and nests bundle/installed under slot_status. A strict string
// or a top-level-only read rejects or empties every real document.
const raucSlotSchema = z.object({
	class: z.string(),
	bootname: z.string().nullish(),
	state: z.string(),
	boot_status: z.string().nullish(),
	...slotContentSchema,
	slot_status: z.object(slotContentSchema).nullish(),
});
const raucStatusSchema = z.object({
	boot_primary: z.string().nullish(),
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
			const installedAt =
				slot.slot_status?.installed?.timestamp ?? slot.installed?.timestamp;
			const bundleVersion =
				slot.slot_status?.bundle?.version ?? slot.bundle?.version;
			const mirror =
				validReceipt.success &&
				(validReceipt.data.target_slot === name ||
					validReceipt.data.target_slot === slot.bootname) &&
				(!installedAt ||
					(Number.isFinite(Date.parse(installedAt)) &&
						Date.parse(installedAt) <=
							Date.parse(validReceipt.data.completed_at)))
					? validReceipt.data
					: null;
			return [
				{
					name,
					bootname: slot.bootname ?? null,
					state: slot.state,
					bootStatus: slot.boot_status ?? null,
					version: mirror?.image_version || bundleVersion || null,
					lastSyncedAt: mirror?.completed_at ?? null,
				},
			];
		}),
	);
}

/**
 * Whether an armed OS activation has happened, in the terms the image's
 * `ceralive-rauc-activate` uses to decide whether to run `mark-active other`.
 *
 * - `pending`: that hook would still activate: the booted slot is RAUC's
 *   primary and the other slot holds an install newer than its last activation
 *   (RAUC drops the `activated` stamp when it installs). Nothing was activated,
 *   so a reboot in this state (crash, watchdog, power loss) is not a rollback.
 * - `consumed`: the hook has nothing left to activate (the other slot's install
 *   was activated, the bootloader is not booting the primary, or the other slot
 *   carries no install), so the reboot may be judged against the staged version.
 * - `unknown`: the document cannot answer; the caller must not reach a verdict.
 */
export type StagedActivation = "pending" | "consumed" | "unknown";

function stampMs(value: string | null | undefined): number | undefined {
	return value ? Date.parse(value) : undefined;
}

export function parseStagedActivation(stdout: string): StagedActivation {
	let document: unknown;
	try {
		document = JSON.parse(stdout);
	} catch {
		return "unknown";
	}
	const parsed = raucStatusSchema.safeParse(document);
	if (!parsed.success) return "unknown";
	const rootfs = parsed.data.slots
		.flatMap((item) => Object.entries(item))
		.filter(([, slot]) => slot.class === "rootfs");
	const booted = rootfs.filter(([, slot]) => slot.state === "booted");
	const other = rootfs.find(([, slot]) => slot.state === "inactive");
	const [bootedName] = booted[0] ?? [];
	if (rootfs.length !== 2 || booted.length !== 1 || !bootedName || !other)
		return "unknown";
	if (!parsed.data.boot_primary) return "unknown";
	if (parsed.data.boot_primary !== bootedName) return "consumed";
	const [, slot] = other;
	const installed = stampMs(
		slot.slot_status?.installed?.timestamp ?? slot.installed?.timestamp,
	);
	const activated = stampMs(
		slot.slot_status?.activated?.timestamp ?? slot.activated?.timestamp,
	);
	if (installed === undefined) return "consumed";
	if (Number.isNaN(installed) || Number.isNaN(activated)) return "unknown";
	return activated === undefined || installed > activated
		? "pending"
		: "consumed";
}

async function readRaucStatusDetailed(
	run: typeof spawnWithTimeout,
): Promise<string> {
	const result = await run(
		["rauc", "status", "--detailed", "--output-format=json"],
		{ timeoutMs: 10_000 },
	);
	if (result.exitCode !== 0) throw new Error("rauc status failed");
	return result.stdout;
}

export async function readBothSlotStatus(
	run: typeof spawnWithTimeout = spawnWithTimeout,
): Promise<RootSlotStatus[]> {
	const stdout = await readRaucStatusDetailed(run);
	const file = Bun.file(SYNC_RECEIPT_FILE);
	const receipt = (await file.exists()) ? await file.json() : null;
	return parseBothSlotStatus(stdout, receipt);
}

export async function readStagedActivation(
	run: typeof spawnWithTimeout = spawnWithTimeout,
): Promise<StagedActivation> {
	return parseStagedActivation(await readRaucStatusDetailed(run));
}
