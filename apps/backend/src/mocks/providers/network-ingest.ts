/*
	CeraUI - Network-Ingest Gateway Mock Provider

	Deterministic stand-in for the network-ingest gateway signals (dev/mock ONLY —
	never spawns `systemctl`, never reads `/etc/mediamtx.yml`). The gated refresh in
	network-ingest.ts short-circuits BEFORE any Bun.spawn/file-read on a dev/emulated
	host and consults this resolver instead, then runs the SAME fail-closed
	`resolveSrtTopology` merge the real path does — so a test drives real topology
	logic, not a hardcoded result. Dev scenarios expose the OLD-topology srt unit +
	rtmp active by default (the image bakes them in); tests flip individual signals
	to simulate BOTH topologies and the false-positive case. Mirrors the
	relay/policy-route seams.
*/

import type { RequiresGateway } from "@ceraui/rpc/schemas";
import type { NetworkIngestGatewaySignals } from "../../modules/network/network-ingest.ts";
import {
	getMockState,
	shouldUseMocks,
	updateMockState,
} from "../mock-service.ts";

/** The dev/mock raw gateway signals (OLD-topology srt unit + rtmp active by default). */
export function resolveMockNetworkIngestSignals(): NetworkIngestGatewaySignals {
	const state = getMockState();
	return {
		rtmpUnitActive: state.networkIngestActive.rtmp,
		srtUnitActive: state.networkIngestActive.srt,
		mediamtxSrt: state.networkIngestMediamtxSrt,
	};
}

/** Flip a gateway unit's mock active state (test seam). No-op unless mocks active. */
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

/**
 * Set whether the mock MediaMTX config proves SRT is bound (NEW topology + the
 * false-positive guard). No-op unless mocks active.
 */
export function setMockNetworkIngestMediamtxSrt(enabled: boolean): void {
	if (!shouldUseMocks()) {
		return;
	}
	updateMockState({ networkIngestMediamtxSrt: enabled });
}
