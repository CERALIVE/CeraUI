import { basename } from "node:path";
import {
	type AddonDescriptor,
	AddonDescriptorSchema,
} from "@ceraui/rpc/schemas";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../system/update-orchestrator/stored-state-file.ts";

export class AddonDescriptorIdentityError extends Error {
	override readonly name = "AddonDescriptorIdentityError";
	constructor(
		readonly slot: string,
		readonly descriptorId: string,
	) {
		super(`add-on descriptor identity mismatch in ${slot}: ${descriptorId}`);
	}
}

export async function readAddonDescriptor(
	path: string,
): Promise<AddonDescriptor> {
	const raw = await readStoredStateJson(path, STORED_STATE_LIMITS.intent);
	const descriptor = AddonDescriptorSchema.parse(raw);
	const slot = basename(path);
	if (slot !== `${descriptor.id}.json`)
		throw new AddonDescriptorIdentityError(slot, descriptor.id);
	return descriptor;
}
