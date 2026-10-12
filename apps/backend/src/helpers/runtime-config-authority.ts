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

export async function readRuntimeConfigAuthority(
	path: string,
): Promise<unknown> {
	try {
		const value = await readStoredStateJson(path, STORED_STATE_LIMITS.packages);
		const raw = value === undefined ? {} : value;
		safetySchema.parse(raw);
		return raw;
	} catch (cause) {
		throw new RuntimeConfigAuthorityError(cause);
	}
}
