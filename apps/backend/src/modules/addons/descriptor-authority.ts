import {
	type AddonDescriptor,
	AddonDescriptorSchema,
} from "@ceraui/rpc/schemas";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../system/update-orchestrator/stored-state-file.ts";

export async function readAddonDescriptor(
	path: string,
): Promise<AddonDescriptor> {
	const raw = await readStoredStateJson(path, STORED_STATE_LIMITS.intent);
	return AddonDescriptorSchema.parse(raw);
}
