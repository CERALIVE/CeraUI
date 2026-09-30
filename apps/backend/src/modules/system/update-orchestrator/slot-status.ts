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
 *   primary and the other slot holds a usable install stamp newer than its
 *   last activation, or has none (RAUC drops the `activated` stamp when it
 *   installs). Nothing was activated, so a reboot in this state (crash,
 *   watchdog, power loss) is not a rollback.
 * - `consumed`: positive evidence that the activation already ran: the other
 *   rootfs slot is the primary (the bootloader fell back from it), or its
 *   activation stamp is at or after its install stamp. Only then may the
 *   reboot be judged against the staged version.
 * - `unknown`: the document cannot answer, including a primary that names
 *   neither rootfs slot and absent or unusable install evidence; the caller
 *   must not reach a verdict. A hook that did nothing because metadata was
 *   missing is not evidence that activation ran.
 */
export type StagedActivation = "pending" | "consumed" | "unknown";

type Stamp =
	| { readonly kind: "absent" }
	| { readonly kind: "at"; readonly ms: number }
	| { readonly kind: "unusable" };

function readStamp(value: string | null | undefined): Stamp {
	if (value === null || value === undefined) return { kind: "absent" };
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? { kind: "at", ms } : { kind: "unusable" };
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
	const [otherName, slot] = other;
	// RAUC reports boot_primary by slot name (every capture: "rootfs.1").
	const primary = parsed.data.boot_primary;
	if (primary === otherName) return "consumed";
	if (primary !== bootedName) return "unknown";
	const installed = readStamp(
		slot.slot_status?.installed?.timestamp ?? slot.installed?.timestamp,
	);
	const activated = readStamp(
		slot.slot_status?.activated?.timestamp ?? slot.activated?.timestamp,
	);
	if (installed.kind !== "at" || activated.kind === "unusable")
		return "unknown";
	return activated.kind === "absent" || installed.ms > activated.ms
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
