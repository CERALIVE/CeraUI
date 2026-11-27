/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

export { isQualifiedNmManagedHybrid } from "./wifi-ap-sta-capability.ts";
export {
	type ConcurrentApInterface,
	ensureConcurrentApInterface,
	releaseCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface-creation.ts";
export { setConcurrentInterfaceDepsForTest } from "./wifi-concurrent-interface-io.ts";
export {
	confirmHybridActivation,
	HYBRID_CHANNEL_REFUSAL,
	type HybridStationChannel,
	readHybridStationChannel,
	revalidateHybridStationChannel,
} from "./wifi-hybrid-channel.ts";
export { readHybridTargetIdentity } from "./wifi-hybrid-target-identity.ts";
export {
	releaseConcurrentApInterface,
	releaseCreatedHybridTarget,
	revalidateConcurrentApInterface,
} from "./wifi-hybrid-target-policy.ts";
export {
	observeConcurrentInterfacesAtFirstDiscovery,
	resetConcurrentInterfaceDepsForTest,
} from "./wifi-hybrid-target-record.ts";
export { selectConcurrentApInterface } from "./wifi-hybrid-target-selector.ts";
export {
	concurrentApIfname,
	concurrentHotspotBindingFields,
	isConcurrentApIfname,
	isSupportedWifiIfname,
	wifiInterfaceReaders,
} from "./wifi-interface-creation.ts";
