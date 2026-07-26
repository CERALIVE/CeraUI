/**
 * Network interface Zod schemas
 */
import { z } from 'zod';

// Accepts dotted-quad IPv4 or a colon-delimited IPv6 hextet string.
export const IP_ADDRESS_REGEX = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;

// Network interface entry schema
export const netifEntrySchema = z.object({
	ip: z.string().optional(),
	tp: z.number(),
	enabled: z.boolean(),
	error: z.string().optional(),
	mac: z.string().optional(),
	// Informational CIDR shared with other enabled interfaces; not an error (the
	// AP/hotspot and lone interfaces are absent). Additive-optional.
	same_subnet_group: z.string().optional(),
	// Real-device diagnostic for a bonded (modem/wifi) interface, additive-optional
	// and TRISTATE. `true` = missing its SRTLA source-routing policy rule or its
	// table's default route; `false` = the check ran and found neither missing;
	// ABSENT = the check could not run (dev host, spawn failure) and carries no
	// verdict — absence is "no news", never an all-clear.
	policy_route_missing: z.boolean().optional(),
	// Measured interface throughput in BITS PER SECOND over the last sample
	// window. Distinct from `tp`, which is a raw TX byte delta over an unstated
	// interval and therefore cannot be rendered as a rate. Additive-optional.
	tx_bps: z.number().optional(),
	rx_bps: z.number().optional(),
});
export type NetifEntry = z.infer<typeof netifEntrySchema>;

// Network interfaces message schema
export const netifMessageSchema = z.record(z.string(), netifEntrySchema);
export type NetifMessage = z.infer<typeof netifMessageSchema>;

// Network interface config input schema
export const netifConfigInputSchema = z.object({
	name: z.string(),
	ip: z.string().regex(IP_ADDRESS_REGEX, 'Invalid IP address format').optional(),
	enabled: z.boolean(),
});
export type NetifConfigInput = z.infer<typeof netifConfigInputSchema>;

// Network interface config output schema
export const netifConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: netifConfigInputSchema.partial().optional(),
});
export type NetifConfigOutput = z.infer<typeof netifConfigOutputSchema>;

// Returned by network.setIngestEnabled on a dev/emulated (non-mock) host, where
// the systemd gateway units do not exist so the toggle is a no-op.
export const NETWORK_INGEST_UNAVAILABLE_ERROR = 'network_ingest_unavailable_in_emulated_mode';

export const networkIngestProtocolInputSchema = z.enum(['rtmp', 'srt']);
export type NetworkIngestProtocolInput = z.infer<typeof networkIngestProtocolInputSchema>;

// Operator enable/disable of a LAN RTMP/SRT ingest gateway (desired state).
export const setIngestEnabledInputSchema = z.object({
	protocol: networkIngestProtocolInputSchema,
	enabled: z.boolean(),
});
export type SetIngestEnabledInput = z.infer<typeof setIngestEnabledInputSchema>;

export const setIngestEnabledOutputSchema = z.object({
	success: z.boolean(),
	applied: setIngestEnabledInputSchema.optional(),
	error: z.string().optional(),
});
export type SetIngestEnabledOutput = z.infer<typeof setIngestEnabledOutputSchema>;
