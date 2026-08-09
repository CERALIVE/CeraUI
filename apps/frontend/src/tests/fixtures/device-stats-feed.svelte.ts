/**
 * A REACTIVE stand-in for `$lib/rpc/subscriptions.svelte`.
 *
 * The history store reads the broadcast getters inside an `$effect`, so a plain
 * function returning a captured variable would be read exactly once and never
 * again — the ring would look frozen for reasons that have nothing to do with
 * the code under test. This fixture holds the payload in `$state` so publishing
 * a new object re-runs that effect the way the real subscription does.
 */

import type { DeviceStats } from "@ceraui/rpc/schemas";

let deviceStats = $state<DeviceStats | undefined>(undefined);

export function publishDeviceStats(next: DeviceStats | undefined): void {
	deviceStats = next;
}

export function getDeviceStats(): DeviceStats | undefined {
	return deviceStats;
}

export function getEncoderLoadSnapshot(): undefined {
	return undefined;
}

export function getIsStreaming(): boolean {
	return false;
}

export function getSensors(): undefined {
	return undefined;
}
