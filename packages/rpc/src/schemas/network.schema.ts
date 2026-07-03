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
	// True when a bonded (modem/wifi) interface is missing its SRTLA source-routing
	// policy rule or its table's default route. Real-device diagnostic; additive-optional.
	policy_route_missing: z.boolean().optional(),
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
