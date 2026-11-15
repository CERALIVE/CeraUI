import { jest } from "bun:test";
import * as nm from "../../modules/network/network-manager.ts";
import { wifiAdapterModeRecorder } from "../../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../../modules/wifi/wifi-hotspot-config.ts";

export const policyStop = (disconnect: () => Promise<boolean>) =>
	wifiHotspotStop(
		{ device: 0 },
		{
			...defaultHotspotStopDeps,
			recordIntent: wifiAdapterModeRecorder,
			nmConnSetFields: (uuid, fields) => nm.nmConnSetFields(uuid, fields),
			nmDisconnect: disconnect,
			broadcastState: () => undefined,
			setDupIpSuppression: () => undefined,
			releaseConcurrentInterface: async () => undefined,
			rescan: async () => undefined,
			publishOutcome: () => undefined,
		},
	);

export async function advancePolicy(ms: number): Promise<void> {
	jest.advanceTimersByTime(ms);
	for (let turn = 0; turn < 256; turn++) await Promise.resolve();
}
