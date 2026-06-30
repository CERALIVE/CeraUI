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
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
