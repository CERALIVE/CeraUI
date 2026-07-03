/*
	CeraUI - Policy-Route Self-Check Mock Provider

	Deterministic stand-in for the policy-route self-check (dev/mock ONLY — never
	spawns `ip rule`/`ip route`). The gated orchestration in policy-route-check.ts
	short-circuits BEFORE any Bun.spawn on a dev/emulated host and consults this
	resolver instead. Default: no flags (null). A forced fault
	(setMockPolicyRouteFault) reports the named interfaces as policy_route_missing,
	so dev/e2e can simulate a missing source rule or absent default route without a
	real device. Mirrors the relay-validate mock seam pattern.
*/

import { getMockState } from "../mock-service.ts";

export function resolveMockPolicyRouteMissing(): Set<string> | null {
	const fault = getMockState().policyRouteFault;
	if (fault) {
		return new Set(fault.missingIfaces);
	}
	return null;
}
