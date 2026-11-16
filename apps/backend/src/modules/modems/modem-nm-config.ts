import { normalizeModemConnectionFields } from "@ceraui/rpc/schemas";
import type { NetworkManagerConnectionModemConfig } from "../network/network-manager.ts";
import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import type { ModemConfig } from "./modems-state.ts";

export function sanitizeModemConfigForNetworkManager(config: ModemConfig) {
	Object.assign(
		config,
		normalizeModemConnectionFields(config, resolveGsmAutoconfigSupport()),
	);

	const fields: NetworkManagerConnectionModemConfig = {
		"gsm.apn": config.apn,
		"gsm.username": config.username,
		"gsm.password": config.password,
		"gsm.password-flags": !config.password ? "4" : "0",
		"gsm.home-only": config.roaming ? "no" : "yes",
		"gsm.network-id": config.network,
		"gsm.auto-config": config.autoconfig ? "yes" : "no",
	};

	return fields;
}
