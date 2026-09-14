import type { DeviceStatsPayload } from "./device-stats.ts";

let snapshot: DeviceStatsPayload | undefined;

export function getDeviceStatsSnapshot(): DeviceStatsPayload | undefined {
	return snapshot;
}

export function recordDeviceStatsSnapshot(
	reading: DeviceStatsPayload | undefined,
): void {
	snapshot = reading;
}
