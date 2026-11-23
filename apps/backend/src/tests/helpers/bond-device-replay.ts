import {
	type DeviceDetectionDeps,
	defaultDeviceDetectionDeps,
} from "../../modules/system/device-detection.ts";

export function bondDeviceProbe(
	unforcedBoot: boolean,
	real: boolean,
	holdFirstRead: boolean,
) {
	const pending = Promise.withResolvers<string>();
	const compatible = real ? "rockchip,rk3588" : "";
	const noEvidence = async () => "";
	let reads = 0;
	let released = false;
	const deps: DeviceDetectionDeps = {
		...defaultDeviceDetectionDeps,
		getDeviceTypeOverride: () =>
			unforcedBoot ? undefined : process.env.CERALIVE_DEVICE_TYPE,
		readDeviceTreeCompatible: async () =>
			holdFirstRead && ++reads === 1 ? pending.promise : compatible,
		readDeviceTreeModel: noEvidence,
		readCeraliveRelease: noEvidence,
		readDmiProductName: noEvidence,
		readDmiBoardName: noEvidence,
	};
	return {
		deps,
		get firstReadPending() {
			return reads > 0 && !released;
		},
		release: () => {
			released = true;
			pending.resolve(compatible);
		},
	};
}

export const pendingProbeIp = "198.51.100.60";
