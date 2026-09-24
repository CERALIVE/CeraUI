import {
	type UpdateCapabilities,
	updateCapabilityFileSchema,
} from "@ceraui/rpc/schemas";
import type { z } from "zod";

export const UPDATE_CAPABILITIES_FILE =
	"/usr/lib/ceralive/update-capabilities.json";

export async function readUpdateCapabilityFile(
	filePath = UPDATE_CAPABILITIES_FILE,
): Promise<z.infer<typeof updateCapabilityFileSchema> | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(filePath).text());
	} catch {
		return undefined;
	}
	const parsed = updateCapabilityFileSchema.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

export async function readUpdateCapabilities(
	filePath = UPDATE_CAPABILITIES_FILE,
): Promise<UpdateCapabilities> {
	const legacy: UpdateCapabilities = { mode: "legacy", features: [] };
	const parsed = await readUpdateCapabilityFile(filePath);
	if (!parsed?.features.includes("apt-all-packages")) {
		return legacy;
	}
	return { mode: "capable", features: parsed.features };
}
