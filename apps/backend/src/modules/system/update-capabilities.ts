import {
	type UpdateCapabilities,
	updateCapabilityFileSchema,
} from "@ceraui/rpc/schemas";
import type { z } from "zod";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";

export const UPDATE_CAPABILITIES_FILE =
	"/usr/lib/ceralive/update-capabilities.json";
let capabilityPath = UPDATE_CAPABILITIES_FILE;

export class UpdateCapabilityReadError extends Error {
	override readonly name = "UpdateCapabilityReadError";
	readonly reason = "discovery_failed";
	constructor(cause: unknown) {
		super("update capability regime unknown", { cause });
	}
}

export function setUpdateCapabilityPathForTest(path: string | null): void {
	capabilityPath = path ?? UPDATE_CAPABILITIES_FILE;
}

export async function readUpdateCapabilityFile(
	filePath = UPDATE_CAPABILITIES_FILE,
): Promise<z.infer<typeof updateCapabilityFileSchema> | undefined> {
	let raw: unknown;
	try {
		raw = await readStoredStateJson(filePath, STORED_STATE_LIMITS.settings);
	} catch (cause) {
		throw new UpdateCapabilityReadError(cause);
	}
	if (raw === undefined) return undefined;
	const parsed = updateCapabilityFileSchema.safeParse(raw);
	if (!parsed.success) throw new UpdateCapabilityReadError(parsed.error);
	return parsed.data;
}

export async function readUpdateCapabilities(
	filePath = capabilityPath,
): Promise<UpdateCapabilities> {
	const legacy: UpdateCapabilities = { mode: "legacy", features: [] };
	const parsed = await readUpdateCapabilityFile(filePath);
	if (!parsed?.features.includes("apt-all-packages")) {
		return legacy;
	}
	return { mode: "capable", features: parsed.features };
}

export function hasKernelAptStage(caps: UpdateCapabilities): boolean {
	return caps.mode === "capable" && caps.features.includes("kernel-apt-stage");
}
