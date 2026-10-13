import type { UpdateTransportFinding } from "@ceraui/rpc/schemas";

export function connectionReachabilityKey(
	finding: UpdateTransportFinding,
):
	| "settings.updates.connection.reachable"
	| "settings.updates.connection.unreachable"
	| "settings.updates.connection.reachabilityUnknown" {
	if (finding.healthy) return "settings.updates.connection.reachable";
	if (
		finding.states.some(
			(state) => state !== "clear" && state !== "probe-unavailable",
		)
	)
		return "settings.updates.connection.unreachable";
	return "settings.updates.connection.reachabilityUnknown";
}
