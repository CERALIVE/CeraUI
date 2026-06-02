/**
 * WiFi Procedures
 * Wraps existing WiFi logic from modules/wifi/
 */

import {
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

import {
	getMockState,
	mockWifiRadios,
	mockWifiSsidForUuid,
	setMockWifiConnection,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import { setMockHotspotConfig } from "../../mocks/providers/wifi.ts";
import { handleWifi, wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const MOCK_WIFI_DEVICE = "wlan0";

function resolveMockWifiDevice(device: string): string | undefined {
	if (mockWifiRadios.some((radio) => radio.device === device)) return device;
	const index = Number.parseInt(device, 10);
	return Number.isNaN(index) ? undefined : mockWifiRadios[index]?.device;
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
 * Connect to saved WiFi procedure
 */
export const wifiConnectProcedure = authedProcedure
	.input(wifiConnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			connect: input.uuid,
		});
		if (shouldUseMocks()) {
			const ssid = mockWifiSsidForUuid(input.uuid);
			if (ssid) {
				setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: ssid });
			}
		}
		return { success: true };
	});

/**
 * Disconnect WiFi procedure
 */
export const wifiDisconnectProcedure = authedProcedure
	.input(wifiDisconnectInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			disconnect: input.uuid,
		});
		if (shouldUseMocks()) {
			setMockWifiConnection(MOCK_WIFI_DEVICE, { activeNetwork: undefined });
		}
		return { success: true };
	});

/**
 * Connect to new WiFi procedure
 */
export const wifiConnectNewProcedure = authedProcedure
	.input(wifiNewInputSchema)
	.output(wifiOperationOutputSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
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
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			forget: input.uuid,
		});
		if (shouldUseMocks()) {
			const ssid = mockWifiSsidForUuid(input.uuid);
			if (ssid) {
				const current = getMockState().wifiConnections.get(MOCK_WIFI_DEVICE);
				setMockWifiConnection(MOCK_WIFI_DEVICE, {
					savedNetworks: (current?.savedNetworks ?? []).filter((s) => s !== ssid),
					activeNetwork:
						current?.activeNetwork === ssid ? undefined : current?.activeNetwork,
				});
			}
		}
		return { success: true };
	});

/**
 * Scan WiFi procedure
 */
export const wifiScanProcedure = authedProcedure
	.input(wifiScanInputSchema)
	.output(successResponseSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			scan: input.device,
		});
		return { success: true };
	});

/**
 * Start hotspot procedure
 */
export const hotspotStartProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			hotspot: { start: { device: input.device } },
		});
		if (shouldUseMocks()) {
			const device = resolveMockWifiDevice(input.device);
			if (device) {
				getMockState().wifiModes[device] = "hotspot";
				setMockWifiConnection(device, { activeNetwork: undefined });
			}
		}
		return { success: true };
	});

/**
 * Stop hotspot procedure
 */
export const hotspotStopProcedure = authedProcedure
	.input(hotspotToggleInputSchema)
	.output(successResponseSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
			hotspot: { stop: { device: input.device } },
		});
		if (shouldUseMocks()) {
			const device = resolveMockWifiDevice(input.device);
			if (device) {
				getMockState().wifiModes[device] = "station";
			}
		}
		return { success: true };
	});

/**
 * Configure hotspot procedure
 */
export const hotspotConfigureProcedure = authedProcedure
	.input(hotspotConfigInputSchema)
	.output(successResponseSchema)
	.handler(({ input, context }) => {
		handleWifi(context.ws as unknown as import("ws").default, {
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
