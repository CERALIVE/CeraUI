import { NmcliMonitorManager } from "../../modules/network/monitor/monitor-manager.ts";
import {
	bondDisableSimulationSelected,
	setBondDisableGuardContext,
} from "../../modules/network/network-interfaces.ts";
import {
	type BondGuardDeviceObserver,
	type DeviceDetectionDeps,
	observeRealDeviceAtBoot,
} from "../../modules/system/device-detection.ts";

export function bootDevice(deps: DeviceDetectionDeps): BondGuardDeviceObserver {
	return observeRealDeviceAtBoot(bondDisableSimulationSelected(), deps);
}

export function installDevice(
	device: BondGuardDeviceObserver | undefined,
	monitor: object,
) {
	setBondDisableGuardContext(device, monitor instanceof NmcliMonitorManager);
}
