import type { ModemCredential } from "../modems/modem-credentials.ts";

export const ROUTER_CREDENTIAL_DEFAULTS = {
	"huawei-hilink": null,
	"generic-rndis": { username: "admin", password: "admin" },
	default: null,
} as const satisfies Record<string, ModemCredential | null>;

export function resolveRouterCredential(
	profile: keyof typeof ROUTER_CREDENTIAL_DEFAULTS,
	operatorCredential?: ModemCredential,
): ModemCredential | undefined {
	return operatorCredential ?? ROUTER_CREDENTIAL_DEFAULTS[profile] ?? undefined;
}
