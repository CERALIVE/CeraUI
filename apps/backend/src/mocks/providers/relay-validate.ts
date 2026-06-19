/*
	CeraUI - Relay Validate Mock Provider

	Deterministic stand-in for the dns+probe NETWORK stages of relay.validate
	(test-infra only — never egress). The seam in relay.procedure.ts runs the
	input/protocol/endpoint adapter checks first, then hands off to this resolver
	in mock mode so e2e can exercise relay.validate WITHOUT a real DNS lookup or
	UDP probe. Default: a successful probe; a forced fault (setMockRelayValidateFault)
	makes the named network stage fail instead.
*/

import type { RelayValidateOutput } from "@ceraui/rpc/schemas";
import { getMockState } from "../mock-service.ts";

export function resolveMockRelayValidate(): RelayValidateOutput {
	const fault = getMockState().relayValidateFault;
	if (fault) {
		return { valid: false, stage: fault.stage, reason: fault.reason };
	}
	return { valid: true, stage: "probe" };
}
