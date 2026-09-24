import {
	type UpdateCapabilities,
	updateCapabilityFileSchema,
} from "@ceraui/rpc/schemas";

export const UPDATE_CAPABILITIES_FILE =
	"/usr/lib/ceralive/update-capabilities.json";

export async function readUpdateCapabilities(
	filePath = UPDATE_CAPABILITIES_FILE,
): Promise<UpdateCapabilities> {
	const legacy: UpdateCapabilities = { mode: "legacy", features: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(filePath).text());
	} catch {
		return legacy;
	}
	const parsed = updateCapabilityFileSchema.safeParse(raw);
	if (!parsed.success || !parsed.data.features.includes("apt-all-packages")) {
		return legacy;
	}
	return { mode: "capable", features: parsed.data.features };
}
