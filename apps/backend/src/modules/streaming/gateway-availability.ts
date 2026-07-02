import type { RequiresGateway } from "@ceraui/rpc/schemas";

/**
 * Real-device "is the network-ingest gateway up?" probe (Task 17).
 *
 * A pipeline whose source is a local ingest server (rtmp/srt) can only encode
 * once its gateway is receiving a feed, so `streaming.start` blocks the launch
 * until this reports the gateway active. The dev/mock branch lives in the mock
 * layer; this module owns only the production path.
 *
 * Todo 16 lands the real gateway-status probe (`getNetworkIngestInfo()`). Until
 * it does, the default stub reports every gateway INACTIVE (fail-safe: a start is
 * blocked rather than silently passing a gate meant to protect it). Todo 16 wires
 * its probe by calling `setGatewayProbe()` at boot.
 */
export interface GatewayProbe {
	isActive(kind: RequiresGateway): boolean;
}

const stubProbe: GatewayProbe = {
	isActive: () => false,
};

let activeProbe: GatewayProbe = stubProbe;

/** Wire the production gateway probe (Todo 16 seam; also used by tests). */
export function setGatewayProbe(probe: GatewayProbe): void {
	activeProbe = probe;
}

/** Restore the fail-safe stub (test teardown). */
export function resetGatewayProbe(): void {
	activeProbe = stubProbe;
}

/** Whether the given network-ingest gateway is active on a real device. */
export function isGatewayActive(kind: RequiresGateway): boolean {
	return activeProbe.isActive(kind);
}
