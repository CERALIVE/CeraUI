/**
 * WiFi Procedures
 * Wraps existing WiFi logic from modules/wifi/
 *
 * Mutating procedures (connect, disconnect, forget, scan, hotspotStart,
 * hotspotStop) are serialized per WiFi interface via `withDeviceLock`, keyed by
 * the interface MAC address. A concurrent operation on the same interface
 * returns `{ success: false, error: 'DEVICE_BUSY' }` without touching state.
 */

import {
	HotspotInfoOutput,
	hotspotConfigInputSchema,
	hotspotToggleInputSchema,
	successResponseSchema,
	wifiConnectInputSchema,
	wifiDisconnectInputSchema,
	wifiForgetInputSchema,
	wifiNewInputSchema,
	wifiOperationOutputSchema,
	wifiScanInputSchema,
	wifiStatusSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import type WebSocket from "ws";

import {
	getMockState,
	mockWifiRadios,
	mockWifiSsidForUuid,
	setMockWifiConnection,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { setMockHotspotConfig } from "../../mocks/providers/wifi.ts";
import { withDeviceLock } from "../../modules/network/state/device-lock.ts";
import { handleWifi, wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import { getWifiInterfacesByMacAddress } from "../../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotInfoDeps,
	resolveHotspotInfo,
} from "../../modules/wifi/wifi-hotspot-info.ts";
import { broadcast } from "../events.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const MOCK_WIFI_DEVICE = "wlan0";

type MutationResult = { success: boolean; error?: string };

function resolveMockWifiDevice(device: string): string | undefined {
	if (mockWifiRadios.some((radio) => radio.device === device)) return device;
	const index = Number.parseInt(device, 10);
	return Number.isNaN(index) ? undefined : mockWifiRadios[index]?.device;
}

// Resolve a WiFi interface MAC from a device index ("0", "1", ...). The MAC is
// the per-device lock key shared across all mutating WiFi procedures.
function macForDeviceId(device: string): string | undefined {
	const id = Number.parseInt(device, 10);
	if (Number.isNaN(id)) return undefined;
	const interfaces = getWifiInterfacesByMacAddress();
	for (const mac in interfaces) {
		if (interfaces[mac]?.id === id) return mac;
	}
	return undefined;
}

// Resolve the owning interface MAC from a saved/active connection UUID so that
// connect/disconnect/forget lock the same interface a hotspot toggle would.
function macForConnectionUuid(uuid: string): string | undefined {
	const interfaces = getWifiInterfacesByMacAddress();
	for (const mac in interfaces) {
		const iface = interfaces[mac];
		if (!iface) continue;
		if (iface.conn === uuid) return mac;
		for (const ssid in iface.saved) {
			if (iface.saved[ssid] === uuid) return mac;
		}
	}
	return undefined;
}

// Run `op` under the per-device lock when the device resolves; returns true when
// the lock rejected the call (busy). When the device cannot be resolved there is
// no interface to serialize against, so `op` runs without a guard.
async function runGuarded(
	deviceId: string | undefined,
	op: () => void | Promise<void>,
): Promise<boolean> {
	if (!deviceId) {
		await op();
		return false;
	}
	const result = await withDeviceLock(deviceId, async () => {
		await op();
	});
	return !result.success;
}

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get WiFi status procedure
 */
export const getWifiStatusProcedure = authedProcedure
	.output(wifiStatusSchema)
	.handler(() => {
		return wifiBuildMsg();
	});

/**
 * Get hotspot info procedure (SSID + gateway IP + active flag; never a password)
 */
export const hotspotInfoProcedure = authedProcedure
	.output(HotspotInfoOutput)
	.handler(() => resolveHotspotInfo(defaultHotspotInfoDeps));

/**
 * Connect to saved WiFi procedure
 */
export const wifiConnectProcedure = authedProcedure
	.input(wifiConnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForConnectionUuid(input.uuid), () => {
			handleWifi(ws, { connect: input.uuid });
			if (shouldUseMocks()) {
				const ssid = mockWifiSsidForUuid(input.uuid);
				if (ssid) {
					setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: ssid });
				}
			}
			broadcast("wifi", { connect: [input.uuid] });
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Disconnect WiFi procedure
 */
export const wifiDisconnectProcedure = authedProcedure
	.input(wifiDisconnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForConnectionUuid(input.uuid), () => {
			handleWifi(ws, { disconnect: input.uuid });
			if (shouldUseMocks()) {
				setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: undefined });
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Connect to new WiFi procedure
 */
export const wifiConnectNewProcedure = authedProcedure
	.input(wifiNewInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as WebSocket, {
			new: {
				device: input.device,
				ssid: input.ssid,
				password: input.password,
			},
		});
		if (shouldUseMocks()) {
			const current = getMockState().wifiConnections.get(MOCK_WIFI_DEVICE);
			const savedNetworks = current?.savedNetworks ?? [];
			setMockWifiConnection(MOCK_WIFI_DEVICE, {
				activeNetwork: input.ssid,
				savedNetworks: savedNetworks.includes(input.ssid)
					? savedNetworks
					: [...savedNetworks, input.ssid],
			});
		}
		return { success: true };
	});

/**
 * Forget WiFi procedure
 */
export const wifiForgetProcedure = authedProcedure
	.input(wifiForgetInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForConnectionUuid(input.uuid), () => {
			handleWifi(ws, { forget: input.uuid });
			if (shouldUseMocks()) {
				const ssid = mockWifiSsidForUuid(input.uuid);
				if (ssid) {
					const current = getMockState().wifiConnections.get(MOCK_WIFI_DEVICE);
					setMockWifiConnection(MOCK_WIFI_DEVICE, {
						savedNetworks: (current?.savedNetworks ?? []).filter(
							(s) => s !== ssid,
						),
						activeNetwork:
							current?.activeNetwork === ssid
								? undefined
								: current?.activeNetwork,
					});
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Scan WiFi procedure
 */
export const wifiScanProcedure = authedProcedure
	.input(wifiScanInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForDeviceId(input.device), () => {
			handleWifi(ws, { scan: input.device });
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Start hotspot procedure
 */
export const hotspotStartProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForDeviceId(input.device), () => {
			handleWifi(ws, {
				hotspot: { start: { device: input.device } },
			});
			if (shouldUseMocks()) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					getMockState().wifiModes[device] = "hotspot";
					setMockWifiConnection(device, { activeNetwork: undefined });
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Stop hotspot procedure
 */
export const hotspotStopProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }): Promise<MutationResult> => {
		const ws = context.ws as unknown as WebSocket;
		const busy = await runGuarded(macForDeviceId(input.device), () => {
			handleWifi(ws, {
				hotspot: { stop: { device: input.device } },
			});
			if (shouldUseMocks()) {
				const device = resolveMockWifiDevice(input.device);
				if (device) {
					getMockState().wifiModes[device] = "station";
				}
			}
		});
		if (busy) return { success: false, error: "DEVICE_BUSY" };
		return { success: true };
	});

/**
 * Configure hotspot procedure
 */
export const hotspotConfigureProcedure = authedProcedure
	.input(hotspotConfigInputSchema)
	.output(successResponseSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as WebSocket, {
			hotspot: {
				config: {
					device: input.device,
					name: input.name,
					password: input.password,
					channel: input.channel,
				},
			},
		});
		if (shouldUseMocks()) {
			const device = resolveMockWifiDevice(input.device);
			if (device) {
				setMockHotspotConfig(device, {
					name: input.name,
					password: input.password,
					channel: input.channel,
				});
			}
		}
		return { success: true };
	});
