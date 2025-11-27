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

import { handleWifi, wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

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
		return { success: true };
	});
