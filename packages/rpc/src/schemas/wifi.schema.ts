/**
 * WiFi Zod schemas
 */
import { z } from 'zod';

// WiFi security enum
export const wifiSecuritySchema = z.enum(['WEP', 'WPA', 'WPA2', 'WPA3']);
export type WifiSecurity = z.infer<typeof wifiSecuritySchema>;

// WiFi band names enum
export const wifiBandSchema = z.enum(['auto', 'auto_50', 'auto_24']);
export type WifiBand = z.infer<typeof wifiBandSchema>;

// Available WiFi network schema
export const availableWifiNetworkSchema = z.object({
	active: z.boolean(),
	ssid: z.string(),
	signal: z.number(),
	security: wifiSecuritySchema,
	freq: z.number(),
});
export type AvailableWifiNetwork = z.infer<typeof availableWifiNetworkSchema>;

// Hotspot config schema
export const hotspotConfigSchema = z.object({
	name: z.string(),
	password: z.string(),
	available_channels: z.record(wifiBandSchema, z.object({ name: z.string() })),
	channel: wifiBandSchema,
});
export type HotspotConfig = z.infer<typeof hotspotConfigSchema>;

// WiFi interface schema
export const wifiInterfaceSchema = z.object({
	ifname: z.string(),
	conn: z.string(),
	hw: z.string(),
	hotspot: hotspotConfigSchema.optional(),
	available: z.array(availableWifiNetworkSchema),
	saved: z.record(z.string(), z.string()),
	supports_hotspot: z.boolean(),
});
export type WifiInterface = z.infer<typeof wifiInterfaceSchema>;

// WiFi status schema (keyed by device ID)
export const wifiStatusSchema = z.record(z.string(), wifiInterfaceSchema);
export type WifiStatus = z.infer<typeof wifiStatusSchema>;

// WiFi connect input schema
export const wifiConnectInputSchema = z.object({
	uuid: z.string(),
});
export type WifiConnectInput = z.infer<typeof wifiConnectInputSchema>;

// WiFi disconnect input schema
export const wifiDisconnectInputSchema = z.object({
	uuid: z.string(),
});
export type WifiDisconnectInput = z.infer<typeof wifiDisconnectInputSchema>;

// WiFi new connection input schema
export const wifiNewInputSchema = z.object({
	device: z.string(),
	ssid: z.string(),
	password: z.string(),
});
export type WifiNewInput = z.infer<typeof wifiNewInputSchema>;

// WiFi forget input schema
export const wifiForgetInputSchema = z.object({
	uuid: z.string(),
});
export type WifiForgetInput = z.infer<typeof wifiForgetInputSchema>;

// WiFi scan input schema
export const wifiScanInputSchema = z.object({
	device: z.string(),
});
export type WifiScanInput = z.infer<typeof wifiScanInputSchema>;

// Hotspot start/stop input schema
export const hotspotToggleInputSchema = z.object({
	device: z.string(),
});
export type HotspotToggleInput = z.infer<typeof hotspotToggleInputSchema>;

// Hotspot config input schema
export const hotspotConfigInputSchema = z.object({
	device: z.string(),
	name: z.string(),
	password: z.string(),
	channel: z.string(),
});
export type HotspotConfigInput = z.infer<typeof hotspotConfigInputSchema>;

// WiFi operation output schema
export const wifiOperationOutputSchema = z.object({
	success: z.boolean(),
	error: z.enum(['auth', 'generic']).optional(),
});
export type WifiOperationOutput = z.infer<typeof wifiOperationOutputSchema>;

// WiFi message schema (response from WiFi operations)
export const wifiMessageSchema = z.object({
	connect: z.array(z.string()).optional(),
	device: z.union([z.number(), z.string()]).optional(),
	disconnect: z.string().optional(),
	new: z
		.object({
			error: z.enum(['auth', 'generic']).optional(),
			device: z.union([z.number(), z.string()]).optional(),
			success: z.boolean().optional(),
		})
		.optional(),
});
export type WifiMessage = z.infer<typeof wifiMessageSchema>;
