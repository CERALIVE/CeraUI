import type {
	UpdateTransportFinding,
	UpdateTransportProbeState,
} from "@ceraui/rpc/schemas";

/**
 * States the producer emits only after the link REACHED a server: a TLS,
 * certificate, signature or portal answer (`update-transport/executor.ts`).
 * They prove the link cannot be used for updates, never that it is
 * unreachable (early oracle F4).
 */
const REACHED_BUT_UNUSABLE: readonly UpdateTransportProbeState[] = [
	"credentials-invalid",
	"tampered",
	"tls-error",
	"captive-http",
	"captive-tls",
];

export function connectionReachabilityKey(
	finding: UpdateTransportFinding,
):
	| "settings.updates.connection.reachable"
	| "settings.updates.connection.unreachable"
	| "settings.updates.connection.unusable"
	| "settings.updates.connection.reachabilityUnknown" {
	if (finding.healthy) return "settings.updates.connection.reachable";
	const failures = finding.states.filter(
		(state) => state !== "clear" && state !== "probe-unavailable",
	);
	if (failures.some((state) => REACHED_BUT_UNUSABLE.includes(state)))
		return "settings.updates.connection.unusable";
	if (failures.length > 0) return "settings.updates.connection.unreachable";
	return "settings.updates.connection.reachabilityUnknown";
}
