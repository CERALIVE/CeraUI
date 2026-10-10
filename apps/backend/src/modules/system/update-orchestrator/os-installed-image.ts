import { stat } from "node:fs/promises";
import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { readBootId } from "./os-identity.ts";
import { readHealthyState } from "./slot-sync-state.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const installedImageSchema = z
	.object({
		slot: z.string().regex(/^rootfs\.[0-9]+$/),
		bundleHash: digest,
		checksum: digest,
		installedAt: z.iso.datetime(),
		installedCount: z.number().int().positive(),
	})
	.strict();
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
): InstalledRootfs | null {
	const parsed = documentSchema.parse(JSON.parse(stdout));
	const rootfs = parsed.slots
		.flatMap((row) => Object.entries(row))
		.filter(([, slot]) => slot.class === "rootfs");
	if (
		rootfs.length !== 2 ||
		rootfs.filter(([, slot]) => slot.state === "booted").length !== 1 ||
		rootfs.filter(([, slot]) => slot.state === "inactive").length !== 1
	)
		return null;
	const selected = rootfs.find(([, slot]) => slot.state === role);
	if (!selected) return null;
	const [name, slot] = selected;
	const status = slot.slot_status;
	const identity = installedImageSchema.safeParse({
		slot: name,
		bundleHash: status?.bundle.hash,
		checksum: status?.checksum?.sha256,
		installedAt: status?.installed?.timestamp,
		installedCount: status?.installed?.count,
	});
	return identity.success
		? {
				identity: identity.data,
				device: slot.device,
				bootname: slot.bootname,
				bootStatus: slot.boot_status,
			}
		: null;
}

/** Optional identity evidence: unavailable metadata never changes stage success. */
export async function readInstalledImage(
	role: "booted" | "inactive",
): Promise<InstalledImageIdentity | null> {
	try {
		const result = await spawnWithTimeout(
			["rauc", "status", "--detailed", "--output-format=json"],
			{ timeoutMs: 2_000 },
		);
		if (result.exitCode !== 0) return null;
		const selected = parseInstalledImage(result.stdout, role);
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
