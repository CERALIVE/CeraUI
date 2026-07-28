/**
 * WiFi Zod schemas
 */
import { z } from 'zod';

// Length-only bounds. The hotspot SSID accepts any unicode (no charset
// restriction) and matches the backend's own min-1 check in wifi-hotspot.ts.
export const HOTSPOT_NAME_MIN = 1;
export const HOTSPOT_NAME_MAX = 32;
export const HOTSPOT_PASSWORD_MIN = 8;
export const HOTSPOT_PASSWORD_MAX = 63;
export const WIFI_PASSWORD_MIN = 8;

// Raw nmcli SECURITY token list (e.g. "WPA2", "WPA1 WPA2 802.1X", "" for open).
// The backend passes it through verbatim and the UI matches via substring, so the
// contract is a free-form string — an enum rejected real and mock open/enterprise rows.
export const wifiSecuritySchema = z.string();
export type WifiSecurity = z.infer<typeof wifiSecuritySchema>;

// WiFi band names enum
export const wifiBandSchema = z.enum(['auto', 'auto_50', 'auto_24']);
export type WifiBand = z.infer<typeof wifiBandSchema>;

// A hotspot channel selection: a band-wide auto entry, or a concrete channel
// (`ch_13`) the DEVICE derived at runtime from `iw phy` after applying the
// regulatory domain. The set of legal `ch_N` values is NOT expressible here —
// it depends on the live regdomain and the radio — so this is a SHAPE check
// only. The authoritative acceptance test is the device's own offered set,
// echoed on `hotspotConfigSchema.available_channels`.
export const wifiChannelIdSchema = z
	.string()
	.regex(/^(?:auto|auto_24|auto_50|ch_[1-9][0-9]{0,2})$/, {
		message: 'Channel must be auto, auto_24, auto_50, or a derived ch_<number>',
	});
export type WifiChannelId = z.infer<typeof wifiChannelIdSchema>;

// The kernel's "world" domain: the conservative default when no country is set.
export const WORLD_REGULATORY_DOMAIN = '00';

// ISO-3166-1 alpha-2, or the world domain.
export const REGULATORY_COUNTRY_RE = /^(?:[A-Z]{2}|00)$/;

export const regulatoryCountrySchema = z.string().regex(REGULATORY_COUNTRY_RE, {
	message: 'Country must be an ISO-3166-1 alpha-2 code, or 00 for world',
});
export type RegulatoryCountry = z.infer<typeof regulatoryCountrySchema>;

// An absent `country` clears the selection and returns the radio to world.
export const setWifiCountryInputSchema = z.object({
	country: regulatoryCountrySchema.optional(),
});
export type SetWifiCountryInput = z.infer<typeof setWifiCountryInputSchema>;

export const setWifiCountryOutputSchema = z.object({
	success: z.boolean(),
	// The country actually persisted (post-normalization), absent when cleared.
	applied: regulatoryCountrySchema.optional(),
	// The regulatory domain the KERNEL reports after the change — it can differ
	// from `applied` on an image with no regulatory database, which is precisely
	// the condition the operator needs to see rather than a silent no-op.
	effective: z.string().optional(),
	error: z.enum(['unavailable_in_emulated_mode', 'invalid_country', 'apply_failed']).optional(),
});
export type SetWifiCountryOutput = z.infer<typeof setWifiCountryOutputSchema>;

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
	// name/password/channel mirror the backend's optional WifiHotspot fields — the
	// status builder omits any that are unset, so they can be absent on the wire.
	name: z.string().optional(),
	password: z.string().optional(),
	// Keyed by `wifiChannelIdSchema` — the auto entries plus every channel the
	// device derived from the live regulatory domain. This map IS the offered
	// set: a channel absent from it is rejected by the device.
	available_channels: z.record(wifiChannelIdSchema, z.object({ name: z.string() })),
	channel: wifiChannelIdSchema.optional(),
});
export type HotspotConfig = z.infer<typeof hotspotConfigSchema>;

// WiFi interface schema
export const wifiInterfaceSchema = z.object({
	ifname: z.string(),
	conn: z.string(),
	hw: z.string(),
	hotspot: hotspotConfigSchema.optional(),
	// Absent on a hotspot-mode interface (which carries `hotspot` instead) and on
	// an interface that cannot host a hotspot — the backend omits both there.
	available: z.array(availableWifiNetworkSchema).optional(),
	saved: z.record(z.string(), z.string()),
	supports_hotspot: z.boolean().optional(),
	transition: z.enum(['activating', 'deactivating']).optional(),
	mode: z.enum(['station', 'hotspot']).optional(),
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
	ssid: z.string().min(1, 'SSID cannot be empty'),
	password: z.string().min(WIFI_PASSWORD_MIN, 'Password must be at least 8 characters'),
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
	name: z
		.string()
		.min(HOTSPOT_NAME_MIN, 'Hotspot name must be at least 1 character')
		.max(HOTSPOT_NAME_MAX, 'Hotspot name must be at most 32 characters'),
	password: z
		.string()
		.min(HOTSPOT_PASSWORD_MIN, 'Password must be at least 8 characters')
		.max(HOTSPOT_PASSWORD_MAX, 'Password must be at most 63 characters'),
	channel: wifiChannelIdSchema,
});
export type HotspotConfigInput = z.infer<typeof hotspotConfigInputSchema>;

// WiFi operation output schema
export const wifiOperationOutputSchema = z.object({
	success: z.boolean(),
	// 'DEVICE_BUSY': per-device lock rejected a concurrent op (additive member).
	error: z.enum(['auth', 'generic', 'DEVICE_BUSY']).optional(),
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
