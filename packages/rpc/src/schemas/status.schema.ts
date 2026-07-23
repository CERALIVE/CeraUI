/**
 * Status Zod schemas (full application status)
 */
import { z } from 'zod';

import { modemListSchema } from './modems.schema';
import { audioSourceSchema } from './streaming.schema';
import { lifecycleStateSchema } from './streaming-lifecycle.schema';
import {
	availableUpdatesSchema,
	sshStatusSchema,
	updateStateSchema,
	updatingStatusSchema,
} from './system.schema';
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

// Discriminator token for how the T5 resolver picked the concrete device behind
// an "Auto" audio selection. Without it, `resolved_asrc: null` conflates "embedded
// audio" with "genuinely unresolved / old backend", so the UI can't render the
// embedded state truthfully. The exact literals are a T4/T5/T6/T7 contract.
export const resolvedAsrcReasonSchema = z.enum([
	'embedded',
	'hdmi',
	'camlink',
	'usb-same-device',
	'usb-alias',
	'first-device',
	'pipeline-default',
]);
export type ResolvedAsrcReason = z.infer<typeof resolvedAsrcReasonSchema>;

// Full status message schema
export const statusMessageSchema = z.object({
	set_password: z.boolean().optional(),
	is_streaming: z.boolean(),
	stream_lifecycle: lifecycleStateSchema.optional(),
	available_updates: availableUpdatesFieldSchema,
	updating: updatingStatusSchema,
	update_state: updateStateSchema.optional(),
	ssh: sshStatusSchema,
	wifi: wifiStatusSchema,
	asrcs: z.array(z.string()),
	// Typed audio-source model (Task 4/6). Additive + optional beside the legacy
	// `asrcs: string[]`, which REMAINS for back-compat.
	audio_sources: z.array(audioSourceSchema).optional(),
	// Currently-applied / idle-preview resolution of an "Auto" audio selection
	// (T5): the concrete device id chosen, its `reason` discriminator, and the
	// target a deferred live follow will apply at next start. All additive +
	// nullable + optional — null/absent = no Auto resolution / old backend.
	resolved_asrc: z.string().nullable().optional(),
	resolved_asrc_reason: resolvedAsrcReasonSchema.nullable().optional(),
	pending_audio_follow_asrc: z.string().nullable().optional(),
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
	// Codec of the incoming/decoded source before re-encode (e.g. "h264"), when
	// the engine reports it. Additive + optional — absent on a legacy engine.
	input_codec: z.string().optional(),
	// True on a same-codec passthrough graph (no re-encode; camera fixes the
	// bitrate); absent/false on transcode. Additive + optional (cerastream 0.5.0).
	passthrough: z.boolean().optional(),
});
export type ActiveEncode = z.infer<typeof activeEncodeSchema>;

// The `unavailable_reason` value carried by a protocol whose gateway is running
// but has no reachable LAN/hotspot address to advertise (e.g. modem-only
// connectivity). A modem/WWAN IP is NEVER advertised — the ingress firewall drops
// those paths, so publishing one would be a lie.
export const NETWORK_INGEST_NO_ADDRESS_REASON = 'no_lan_or_hotspot_address';

// Which gateway topology currently serves SRT (Task 16, B2 fleet transition):
// the standalone `srt-live-transmit` unit (OLD) or MediaMTX terminating both
// RTMP and SRT (NEW). Recorded so a consumer distinguishes them without probing.
export const SRT_GATEWAY_TOPOLOGIES = ['mediamtx', 'srt-live-transmit'] as const;
export type SrtGatewayTopology = (typeof SRT_GATEWAY_TOPOLOGIES)[number];

// Network-ingest gateway status surface (Task 16). Four per-protocol states:
//   1. the whole protocol is `null` — the board's capability source kinds exclude
//      it (an N100 profile without `srt` → `srt: null`);
//   2. `{ service_active: false, url }` — the baked-in gateway unit is down;
//   3. `{ service_active: true, url }` — fully reachable at the LAN/hotspot url;
//   4. `{ service_active, url: null, unavailable_reason: "no_lan_or_hotspot_address" }`
//      — the protocol is offered but NO LAN/hotspot address exists (modem-only),
//      so there is no url to publish to — surfaced disabled-with-reason, never
//      hidden and never a modem IP.
// `url` is nullable + `unavailable_reason`/`gateway` optional; all additive, so a
// legacy client still parses the object. `gateway` is the SRT serving topology
// (set only on SRT, only when available); RTMP never sets it.
export const networkIngestProtocolSchema = z.object({
	service_active: z.boolean(),
	url: z.string().nullable(),
	unavailable_reason: z.literal(NETWORK_INGEST_NO_ADDRESS_REASON).optional(),
	gateway: z.enum(SRT_GATEWAY_TOPOLOGIES).optional(),
	// The operator disabled this protocol in Settings (desired-state control). The
	// unit is stopped by the desired-state reconciler; `service_active` stays the
	// UNIT truth (a NEW-topology shared unit may still run for the sibling
	// protocol). Additive-optional, present ONLY when true — like policy_route_missing.
	operator_disabled: z.boolean().optional(),
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
	stream_lifecycle: lifecycleStateSchema.optional(),
	available_updates: availableUpdatesFieldSchema.optional(),
	updating: updatingStatusSchema.optional(),
	update_state: updateStateSchema.optional(),
	ssh: sshStatusSchema.optional(),
	wifi: wifiStatusSchema.optional(),
	modems: modemListSchema.optional(),
	asrcs: z.array(z.string()).optional(),
	// Typed audio-source model (Task 4/6). Additive + optional beside the legacy
	// `asrcs: string[]`, which REMAINS for back-compat.
	audio_sources: z.array(audioSourceSchema).optional(),
	// "Auto" audio resolution mirror (T5) — same additive/nullable/optional
	// contract as on statusMessageSchema above.
	resolved_asrc: z.string().nullable().optional(),
	resolved_asrc_reason: resolvedAsrcReasonSchema.nullable().optional(),
	pending_audio_follow_asrc: z.string().nullable().optional(),
	set_password: z.boolean().optional(),
	remote: remoteStatusSchema.optional(),
	linkTelemetry: linkTelemetryMessageSchema.nullable().optional(),
	buffering: bufferingStatusSchema.nullable().optional(),
	active_encode: activeEncodeSchema.nullable().optional(),
	network_ingest: networkIngestSchema.nullable().optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
