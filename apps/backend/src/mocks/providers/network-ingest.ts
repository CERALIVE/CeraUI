/*
	CeraUI - Network-Ingest Gateway Mock Provider

	Deterministic stand-in for the network-ingest gateway status (dev/mock ONLY —
	never spawns `systemctl`). The gated refresh in network-ingest.ts short-circuits
	BEFORE any Bun.spawn on a dev/emulated host and consults this resolver instead.
	Dev scenarios expose BOTH gateways active by default (the image bakes them in),
	so the frontend Network Ingest card renders live URLs out of the box; a test
	flips one via setMockNetworkIngestActive. Mirrors the relay/policy-route seams.
*/

import type { RequiresGateway } from "@ceraui/rpc/schemas";
import { getMockState, shouldUseMocks, updateMockState } from "../mock-service.ts";

/** The dev/mock service-active state per gateway kind (both active by default). */
export function resolveMockNetworkIngestActive(): Record<
	RequiresGateway,
	boolean
> {
	return { ...getMockState().networkIngestActive };
}

/** Flip a gateway's mock service_active (test seam). No-op unless mocks active. */
export function setMockNetworkIngestActive(
	kind: RequiresGateway,
	active: boolean,
): void {
	if (!shouldUseMocks()) {
		return;
	}
	updateMockState({
		networkIngestActive: {
			...getMockState().networkIngestActive,
			[kind]: active,
		},
	});
}
