/**
 * Status Zod schemas (full application status)
 */
import { z } from 'zod';

import { modemListSchema } from './modems.schema';
import { availableUpdatesSchema, sshStatusSchema, updatingStatusSchema } from './system.schema';
import { wifiStatusSchema } from './wifi.schema';

// Audio sources enum
export const audioSourcesSchema = z.tuple([
	z.literal('Analog in'),
	z.literal('No audio'),
	z.literal('Pipeline default'),
]);
export type AudioSources = z.infer<typeof audioSourcesSchema>;

// Wire shape of `available_updates`: the package summary when updates exist, else
// a falsy sentinel — `false` (apt-update disabled) or `null` (enabled, not yet
// checked). `getStatus` is output-validated, so the sentinels MUST be modelled or
// reconnect re-auth hydration fails with "Output validation failed".
export const availableUpdatesFieldSchema = z.union([
	availableUpdatesSchema,
	z.literal(false),
	z.null(),
]);

// Full status message schema
export const statusMessageSchema = z.object({
	set_password: z.boolean().optional(),
	is_streaming: z.boolean(),
	available_updates: availableUpdatesFieldSchema,
	updating: updatingStatusSchema,
	ssh: sshStatusSchema,
	wifi: wifiStatusSchema,
	asrcs: z.array(z.string()),
	modems: modemListSchema,
});
export type StatusMessage = z.infer<typeof statusMessageSchema>;

// Partial status update schema (for broadcasts)
export const statusUpdateSchema = statusMessageSchema.partial();
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;

// Remote status schema
export const remoteStatusSchema = z.union([z.literal(true), z.object({ error: z.string() })]);
export type RemoteStatus = z.infer<typeof remoteStatusSchema>;

// Per-uplink srtla_send telemetry. Mirror of LinkTelemetryEntry in
// apps/backend/src/modules/streaming/link-telemetry.ts. rtt_ms=0 and
// weight_percent=100 are valid sender constants, not sentinels.
export const linkTelemetryEntrySchema = z.object({
	conn_id: z.string(),
	iface: z.string(),
	rtt_ms: z.number(),
	nak_count: z.number(),
	weight_percent: z.number(),
	stale: z.boolean(),
});
export type LinkTelemetryEntry = z.infer<typeof linkTelemetryEntrySchema>;

export const linkTelemetryMessageSchema = z.object({
	links: z.array(linkTelemetryEntrySchema),
});
export type LinkTelemetryMessage = z.infer<typeof linkTelemetryMessageSchema>;

// Engine store-and-forward (egress-spool) telemetry. Additive cerastream Status
// fields (cerastream Task 32): present only when the engine advertises buffering.
// `active` toggles the calm "buffering — store & forward" HUD indicator; the byte
// counters are informational. snake_case mirrors the engine wire shape so the
// backend passes it through untransformed.
export const bufferingStatusSchema = z.object({
	active: z.boolean(),
	spooled_bytes: z.number().nonnegative().optional(),
	data_headroom_bytes: z.number().nonnegative().optional(),
	disk_warning: z.boolean().optional(),
});
export type BufferingStatus = z.infer<typeof bufferingStatusSchema>;

// Realized runtime encode reported by the engine on the `status` event
// (cerastream `ActiveEncode`, cerastream Todo 10). Reflects the RESOLVED graph
// (post platform-default/override), NOT the requested StartParams. Additive +
// nullable+optional on the status response — an older engine that never emits it
// surfaces no field (same capability-gate pattern as `buffering` above).
// snake_case mirrors the engine wire shape so the backend passes it through.
export const activeEncodeSchema = z.object({
	codec: z.string(),
	resolution: z.string(),
	framerate: z.number(),
	active_input: z.string().optional(),
	decoder: z.string().optional(),
});
export type ActiveEncode = z.infer<typeof activeEncodeSchema>;

// Network-ingest gateway status surface (Task 16). Per protocol: whether the
// baked-in gateway unit (rtmp → ceralive-rtmp-gateway.service, srt →
// ceralive-srt-gateway.service) is active, plus the LAN publish URL. A protocol
// is `null` when the board's capability source kinds exclude it. Additive +
// nullable+optional so an older backend that never emits it surfaces nothing.
export const networkIngestProtocolSchema = z.object({
	service_active: z.boolean(),
	url: z.string(),
});
export type NetworkIngestProtocol = z.infer<typeof networkIngestProtocolSchema>;

export const networkIngestSchema = z.object({
	rtmp: networkIngestProtocolSchema.nullable(),
	srt: networkIngestProtocolSchema.nullable(),
});
export type NetworkIngest = z.infer<typeof networkIngestSchema>;

// Status response message schema (what server sends)
export const statusResponseSchema = z.object({
	is_streaming: z.boolean().optional(),
	available_updates: availableUpdatesFieldSchema.optional(),
	updating: updatingStatusSchema.optional(),
	ssh: sshStatusSchema.optional(),
	wifi: wifiStatusSchema.optional(),
	modems: modemListSchema.optional(),
	asrcs: z.array(z.string()).optional(),
	set_password: z.boolean().optional(),
	remote: remoteStatusSchema.optional(),
	linkTelemetry: linkTelemetryMessageSchema.nullable().optional(),
	buffering: bufferingStatusSchema.nullable().optional(),
	active_encode: activeEncodeSchema.nullable().optional(),
	network_ingest: networkIngestSchema.nullable().optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
