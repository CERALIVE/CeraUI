import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../modules/system/update-orchestrator/stored-state-file.ts";
import { runtimeConfigSchema } from "./config-schemas.ts";

const safetySchema = runtimeConfigSchema.pick({
	autostart: true,
	bond_opt_out: true,
	eth_roles: true,
	wifi_modes: true,
	network_ingest: true,
	addons: true,
	modem_provisioning: true,
	modem_capabilities: true,
});

export class RuntimeConfigAuthorityError extends Error {
	override readonly name = "RuntimeConfigAuthorityError";
	constructor(cause?: unknown) {
		super("runtime_config_authority_unavailable", { cause });
	}
}

/** The authority check alone, for a caller that already holds the parsed JSON. */
export function parseRuntimeConfigAuthority(raw: unknown): unknown {
	safetySchema.parse(raw);
	return raw;
}

export async function readRuntimeConfigAuthority(
	path: string,
): Promise<unknown> {
	try {
		const value = await readStoredStateJson(path, STORED_STATE_LIMITS.packages);
		return parseRuntimeConfigAuthority(value === undefined ? {} : value);
	} catch (cause) {
		throw new RuntimeConfigAuthorityError(cause);
	}
}
