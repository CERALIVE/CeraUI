import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import {
	readStoredStateFileSync,
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "./stored-state-file.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

export const KERNEL_STATE_DIR = "/data/ceralive/update-state";
export const kernelPackage = z
	.string()
	.regex(/^linux-image-[0-9]+\.[0-9]+\.[0-9]+-ceralive-rk3588$/);
export const kernelVersion = z
	.string()
	.regex(/^[0-9]+\.[0-9]+\.[0-9]+-ceralive[1-9][0-9]*$/);
export const kernelIdentitySchema = z
	.object({
		package: kernelPackage,
		version: kernelVersion,
		deb_sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type KernelIdentity = Readonly<z.infer<typeof kernelIdentitySchema>>;
const kernelStateNameSchema = z.enum([
	"staging",
	"staged",
	"armed",
	"activating",
	"activated",
	"succeeded",
	"rolled_back",
	"failed",
]);
export const kernelStateSchema = z
	.object({
		schema: z.literal(1),
		attempt: z.uuid(),
		...kernelIdentitySchema.shape,
		target_slot: z.enum(["A", "B"]),
		booted_slot_at_stage: z.enum(["A", "B"]),
		boot_id_at_activation: z.uuid().nullable(),
		state: kernelStateNameSchema,
		reason: z
			.string()
			.regex(/^[a-z][a-z0-9_]*$/)
			.nullable(),
		timestamps: z.partialRecord(kernelStateNameSchema, z.iso.datetime()),
		acknowledged: z.boolean().optional(),
	})
	.strict()
	.refine((state) => state.target_slot !== state.booted_slot_at_stage)
	.refine(
		(state) =>
			state.state === "staging" ||
			state.state === "failed" ||
			state.timestamps.staged !== undefined,
		{ path: ["timestamps", "staged"], message: "Missing staged timestamp" },
	);
export type KernelState = Readonly<z.infer<typeof kernelStateSchema>>;
export const slotOverlaySchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("invalid"),
			attempt: z.uuid(),
			reason: z.string().regex(/^[a-z][a-z0-9_]*$/),
		})
		.strict(),
	z
		.object({
			status: z.enum(["pending", "confirmed"]),
			attempt: z.uuid(),
			base_bundle_identity: z.unknown(),
			kernel: kernelIdentitySchema,
			reason: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.nullable()
				.optional(),
		})
		.strict(),
]);
export type SlotOverlay = Readonly<z.infer<typeof slotOverlaySchema>>;

export class KernelUpdateError extends Error {
	override readonly name = "KernelUpdateError";
	constructor(
		readonly reason: string,
		options?: ErrorOptions,
	) {
		super(reason, options);
	}
}

export async function readKernelState(
	directory = KERNEL_STATE_DIR,
): Promise<KernelState | null> {
	const raw = await readStoredStateJson(
		join(directory, "kernel-state.json"),
		STORED_STATE_LIMITS.receipt,
	);
	return raw === undefined ? null : kernelStateSchema.parse(raw);
}

export async function readSlotOverlay(
	slot: "A" | "B",
	directory = KERNEL_STATE_DIR,
): Promise<SlotOverlay | null> {
	const raw = await readStoredStateJson(
		join(directory, `slot-overlay-${slot}.json`),
		STORED_STATE_LIMITS.receipt,
	);
	return raw === undefined ? null : slotOverlaySchema.parse(raw);
}

export async function readKernelQuarantine(
	directory = KERNEL_STATE_DIR,
): Promise<readonly KernelIdentity[]> {
	const raw = await readStoredStateJson(
		join(directory, "kernel-quarantine.json"),
		STORED_STATE_LIMITS.quarantine,
	);
	return raw === undefined ? [] : z.array(kernelIdentitySchema).parse(raw);
}

export function kernelPending(state: KernelState | null): boolean {
	return (
		state !== null &&
		!["succeeded", "rolled_back", "failed"].includes(state.state)
	);
}

/** Terminal acknowledgement retains all reconciliation evidence and never edits an overlay. */
export function acknowledgeKernelState(
	attempt: string,
	directory = KERNEL_STATE_DIR,
): void {
	const file = join(directory, "kernel-state.json");
	const text = readStoredStateFileSync(file, STORED_STATE_LIMITS.receipt);
	if (text === null) return;
	const state = kernelStateSchema.parse(parseAuthorityJson(text));
	if (state.attempt !== attempt || kernelPending(state) || state.acknowledged)
		return;
	writeFileAtomicSync(file, JSON.stringify({ ...state, acknowledged: true }));
	syncOrchestratorDirectory(file);
}

export function overlayMatches(
	state: KernelState,
	overlay: SlotOverlay | null,
): boolean {
	return (
		overlay !== null &&
		overlay.status !== "invalid" &&
		overlay.attempt === state.attempt &&
		overlay.kernel.package === state.package &&
		overlay.kernel.version === state.version &&
		overlay.kernel.deb_sha256 === state.deb_sha256
	);
}
