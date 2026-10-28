import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	KERNEL_STATE_DIR,
	kernelIdentitySchema,
	kernelPending,
	overlayMatches,
	readKernelState,
	readSlotOverlay,
	type SlotOverlay,
} from "./kernel-state.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import { readBootId } from "./os-identity.ts";
import { readHealthyState } from "./slot-sync-state.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baseInstalledImageSchema = z
	.object({
		slot: z.string().regex(/^rootfs\.[0-9]+$/),
		bundleHash: digest,
		checksum: digest,
		installedAt: z.iso.datetime(),
		installedCount: z.number().int().positive(),
	})
	.strict();
export const installedImageSchema = baseInstalledImageSchema.extend({
	kernelOverlay: kernelIdentitySchema
		.extend({
			attempt: z.uuid(),
			status: z.enum(["pending", "confirmed"]),
		})
		.strict()
		.optional(),
});
export type InstalledImageIdentity = Readonly<
	z.infer<typeof installedImageSchema>
>;
type InstalledRootfs = {
	readonly identity: InstalledImageIdentity;
	readonly device: string;
	readonly bootname: string | null | undefined;
	readonly bootStatus: string | null | undefined;
};

const documentSchema = z.object({
	slots: z.array(
		z.record(
			z.string(),
			z.object({
				class: z.string(),
				state: z.string(),
				device: z.string(),
				bootname: z.string().nullish(),
				boot_status: z.string().nullish(),
				slot_status: z
					.object({
						bundle: z.object({ hash: digest.optional() }),
						checksum: z.object({ sha256: digest }).optional(),
						installed: z
							.object({
								timestamp: z.iso.datetime(),
								count: z.number().int().positive(),
							})
							.optional(),
					})
					.optional(),
			}),
		),
	),
});

export function parseInstalledImage(
	stdout: string,
	role: "booted" | "inactive",
	overlay: SlotOverlay | null = null,
): InstalledRootfs | null {
	const selected = selectRootfs(stdout, role);
	if (!selected) return null;
	const [name, slot] = selected;
	if (overlay?.status === "invalid") return null;
	const status = slot.slot_status;
	const plain = {
		slot: name,
		bundleHash: status?.bundle.hash,
		checksum: status?.checksum?.sha256,
		installedAt: status?.installed?.timestamp,
		installedCount: status?.installed?.count,
	};
	// Retained RAUC metadata describes old bytes once a local overlay exists.
	const base = overlay
		? baseInstalledImageSchema.safeParse(overlay.base_bundle_identity)
		: null;
	if (base && !base.success) return null;
	const identity = installedImageSchema.safeParse(
		overlay && base?.success
			? {
					...base.data,
					slot: name,
					kernelOverlay: {
						...overlay.kernel,
						attempt: overlay.attempt,
						status: overlay.status,
					},
				}
			: plain,
	);
	return identity.success
		? {
				identity: identity.data,
				device: slot.device,
				bootname: slot.bootname,
				bootStatus: slot.boot_status,
			}
		: null;
}

function selectRootfs(stdout: string, role: "booted" | "inactive") {
	const parsed = documentSchema.parse(parseAuthorityJson(stdout));
	const rootfs = parsed.slots
		.flatMap((row) => Object.entries(row))
		.filter(([, slot]) => slot.class === "rootfs");
	if (
		rootfs.length !== 2 ||
		rootfs.filter(([, slot]) => slot.state === "booted").length !== 1 ||
		rootfs.filter(([, slot]) => slot.state === "inactive").length !== 1
	)
		return null;
	return rootfs.find(([, slot]) => slot.state === role) ?? null;
}

/** Optional identity evidence: unavailable metadata never changes stage success. */
export async function readInstalledImage(
	role: "booted" | "inactive",
	deps = { run: spawnWithTimeout, directory: KERNEL_STATE_DIR },
): Promise<InstalledImageIdentity | null> {
	try {
		const result = await deps.run(
			["rauc", "status", "--detailed", "--output-format=json"],
			{ timeoutMs: 2_000 },
		);
		if (result.exitCode !== 0) return null;
		const slot = selectRootfs(result.stdout, role);
		const bootname = slot?.[1].bootname;
		if (bootname !== "A" && bootname !== "B") return null;
		const overlay = await readSlotOverlay(bootname, deps.directory);
		const kernel = await readKernelState(deps.directory);
		if (
			kernelPending(kernel) &&
			kernel?.target_slot === bootname &&
			!overlayMatches(kernel, overlay)
		)
			return null;
		const selected = parseInstalledImage(result.stdout, role, overlay);
		if (!selected) return null;
		if (role === "booted") {
			const [root, slot, healthy, bootId] = await Promise.all([
				stat("/"),
				stat(selected.device),
				readHealthyState(),
				readBootId(),
			]);
			if (
				root.dev !== slot.rdev ||
				selected.bootStatus !== "good" ||
				healthy?.boot_id !== bootId ||
				(healthy.slot !== selected.identity.slot &&
					healthy.slot !== selected.bootname)
			)
				return null;
		}
		return selected.identity;
	} catch {
		// This optional observation must fail closed, not invent image identity.
		return null;
	}
}

/** Called only after the guarded RAUC install has positively succeeded. */
export async function clearInstalledImageOverlay(
	role: "booted" | "inactive",
	deps = { run: spawnWithTimeout, directory: KERNEL_STATE_DIR },
): Promise<void> {
	const result = await deps.run(
		["rauc", "status", "--detailed", "--output-format=json"],
		{ timeoutMs: 2_000 },
	);
	const slot = result.exitCode === 0 ? selectRootfs(result.stdout, role) : null;
	const bootname = slot?.[1].bootname;
	if (bootname !== "A" && bootname !== "B")
		throw new Error("installed slot unknown");
	const file = join(deps.directory, `slot-overlay-${bootname}.json`);
	try {
		await unlink(file);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	syncOrchestratorDirectory(file);
}
