import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	persistWifiAdapterMode,
	restoreWifiAdapterMode,
} from "./wifi-adapter-mode.ts";
import { publishAdapterModeOutcome } from "./wifi-adapter-mode-outcome.ts";
import type { AdapterModeTransitionDeps } from "./wifi-adapter-mode-transition.ts";
import { readHybridStationChannel } from "./wifi-concurrent-interface.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	defaultHotspotDeps,
	startHotspotLocked,
} from "./wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	type HotspotStopResult,
	stopHotspotForInterfaceLocked,
} from "./wifi-hotspot-config.ts";
import { publishHotspotOutcome } from "./wifi-hotspot-outcome.ts";
import { canHotspot, type HotspotStartResult } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

/**
 * Was the adapter busy at this instant? Acquires and releases immediately, so it
 * never becomes the lock the delegated transaction has to contend with.
 */
async function probeAdapterBusy(macAddress: string): Promise<boolean> {
	const probe = await withWifiAdapterLock(
		wifiAdapterLockKey(macAddress),
		async () => true,
	);
	return !probe.success;
}

export const defaultAdapterModeDeps: AdapterModeTransitionDeps = {
	readHybridChannel: readHybridStationChannel,
	resolveInterfaces: getWifiInterfacesByMacAddress,
	isAdapterBusy: probeAdapterBusy,
	startHotspot: async (device, publish) => {
		const found = findAdapterByDevice(device, getWifiInterfacesByMacAddress());
		const { recordIntent: _recorder, ...deps } = defaultHotspotDeps;
		const result: HotspotStartResult = !found
			? { success: false, error: "no-device" }
			: !canHotspot(found.wifiInterface)
				? { success: false, error: "unsupported" }
				: await startHotspotLocked(found.macAddress, found.wifiInterface, {
						...deps,
						publishOutcome: publish,
					});
		if (!result.success) publish("start", device, result);
		return result;
	},
	stopHotspot: async (device, publish) => {
		const found = findAdapterByDevice(device, getWifiInterfacesByMacAddress());
		const { recordIntent: _recorder, ...deps } = defaultHotspotStopDeps;
		const result: HotspotStopResult = !found
			? { success: false, error: "no-device" }
			: !canHotspot(found.wifiInterface)
				? { success: false, error: "unsupported" }
				: await stopHotspotForInterfaceLocked(
						found.macAddress,
						found.wifiInterface,
						{ ...deps, publishOutcome: publish },
					);
		publish("stop", device, result);
		return result;
	},
	publishOutcome: publishAdapterModeOutcome,
	publishHotspotOutcome,
	persistMode: persistWifiAdapterMode,
	restoreMode: restoreWifiAdapterMode,
	readPersistedMode: getPersistedWifiAdapterMode,
	armTerminalTimeout: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

export function findAdapterByDevice(
	device: number | string,
	interfaces: Readonly<Record<string, WifiInterface>>,
): { macAddress: string; wifiInterface: WifiInterface } | undefined {
	const id = typeof device === "number" ? device : Number.parseInt(device, 10);
	if (Number.isNaN(id)) return undefined;
	for (const macAddress in interfaces) {
		const wifiInterface = interfaces[macAddress];
		if (wifiInterface?.id === id) return { macAddress, wifiInterface };
	}
	return undefined;
}
