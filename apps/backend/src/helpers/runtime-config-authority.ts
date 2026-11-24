import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../modules/system/update-orchestrator/stored-state-file.ts";
import { runtimeConfigSchema } from "./config-schemas.ts";

const safetySchema = runtimeConfigSchema.pick({
	autostart: true,
	bond_opt_out: true,
	bond_group_out: true,
	bond_port_out: true,
	bond_rollback_out: true,
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

/** Validate authority without replacing the caller's raw JSON or unknown keys. */
function assertRuntimeConfigAuthority(
	raw: unknown,
): asserts raw is Record<string, unknown> {
	safetySchema.parse(raw);
}

export function parseRuntimeConfigAuthority(
	raw: unknown,
): Record<string, unknown> {
	assertRuntimeConfigAuthority(raw);
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
