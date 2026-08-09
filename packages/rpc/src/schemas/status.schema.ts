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
// `ambiguous-same-device-audio` and `no-same-device-audio` are the two typed
// NON-resolutions: Auto found either several or no audio devices on the camera's
// own physical device, and CeraLive refuses to guess across devices (ADR-0008 §6).
// They REPLACE the retired `usb-alias` / `first-device` fallbacks, both of which
// could only ever name a DIFFERENT physical device's microphone.
// `no-capture-audio` is the rule-3/4 refusal: the source's fixed audio card IS
// enumerated but owns NO capture PCM (the RK3588 HDMI-RX, even with a locked
// signal), so Auto resolves to an explicit video-only stream rather than binding
// a card whose every start dies `audio-device-unavailable`.
export const resolvedAsrcReasonSchema = z.enum([
	'embedded',
	'hdmi',
	'camlink',
	'usb-same-device',
	'ambiguous-same-device-audio',
	'no-same-device-audio',
	'no-capture-audio',
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
	// The same-physical-device audio candidates behind an
	// `ambiguous-same-device-audio` reason — the exact list the UI must offer for
	// manual selection. Null/absent for every other reason.
	resolved_asrc_candidates: z.array(z.string()).nullable().optional(),
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
	/**
	 * MEASURED wire throughput for this uplink, bits/s — srtla_send's ADR-001
	 * `bitrate_bps` (wire bytes × 8), so SRT/SRTLA headers, ACKs and
	 * retransmits are INCLUDED and this is not the pre-transport payload rate.
	 * Unlike `engine_bitrate.applied_kbps` (a setpoint) it reads ~0 when
	 * nothing is flowing. Additive + optional: absent means UNKNOWN, not zero.
	 */
	bitrate_bps: z.number().nonnegative().optional(),
	/**
	 * CUMULATIVE wire BYTES this uplink has sent this session — srtla_send's
	 * ADR-002 `bytes_sent_total`. Deliberately NOT the same kind of number as
	 * `bitrate_bps` directly above: that is bits per second and carries a
	 * mandatory ×8, this is a byte COUNT and carries none. Same accounting
	 * otherwise (SRT/SRTLA framing and retransmits included, control frames not).
	 * Additive + optional: absent means UNKNOWN, not zero.
	 */
	bytes_sent_total: z.number().int().nonnegative().optional(),
	stale: z.boolean(),
});
export type LinkTelemetryEntry = z.infer<typeof linkTelemetryEntrySchema>;

export const linkTelemetryMessageSchema = z.object({
	links: z.array(linkTelemetryEntrySchema),
	/**
	 * Sum of every link's `bitrate_bps` — the bond's total measured wire
	 * throughput, bits/s. Summed once on the backend so consumers cannot
	 * disagree about which links count. Absent means UNKNOWN, not zero.
	 */
	measured_bps: z.number().nonnegative().optional(),
	/**
	 * CUMULATIVE wire BYTES the whole bond has sent this session — the operator's
	 * "total transferred" figure, in bytes.
	 *
	 * Unlike `measured_bps` this is NOT summed from `links[]`: it is the sender's
	 * own session accumulator, forwarded verbatim, because a link torn down by an
	 * IP-list reload leaves `links[]` while its bytes stay counted. Summing the
	 * live links would make an operator's total run backwards.
	 *
	 * It survives a per-link reconnect and a backend restart that re-adopts a
	 * running stream (the sender owns the counter, not CeraUI); it restarts at 0
	 * only on a genuinely new stream. Absent means UNKNOWN, not zero.
	 */
	bytes_sent_total: z.number().int().nonnegative().optional(),
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

// The engine's adaptive bitrate reading: the rate cerastream has APPLIED to the
// encoder right now (`applied_kbps`) beside the CEILING it was given
// (`ceiling_kbps`). Two different quantities, and conflating them is precisely
// the confusion this field exists to remove.
//
// `config.max_br` is the operator's REQUEST — CeraUI sends it verbatim as the
// engine's `bitrate.max_bitrate`. cerastream's adaptive controller then drives
// the encoder anywhere between `bitrate.min_bitrate` (300 kbps) and that ceiling
// on a 20 ms loop fed by SRT RTT / send-buffer depth / packet loss, and reports
// the outcome on its own `bitrate` event. A 5000 kbps request on a link that
// cannot sustain it therefore runs at ~3000 kbps — correct, protective behaviour
// that CeraUI previously had no way to show, because every surface fell back to
// the ceiling and reported the request as if it were the result.
//
// `applied_kbps` is an ENCODER TARGET, not a measurement of bytes on the wire.
// It is the adaptive controller's own setpoint, so it holds a steady number even
// when ZERO frames are reaching the network — proven on a board reading 4100
// through a 30 s session that carried no media at all. Measured throughput is
// `linkTelemetry.measured_bps` (and `netif.tx_bps` for the whole interface);
// render this one as "Target", never as "the bitrate".
//
// Unlike `buffering` / `active_encode` this is NOT a verbatim pass-through of a
// `status` frame field — it is assembled from a separate event topic, so the
// names state their unit and their role rather than mirroring the engine's
// unit-less `current_bitrate` / `max_bitrate`. Additive + nullable + optional,
// so an engine that emits no `bitrate` event surfaces nothing at all and
// consumers keep their existing configured-ceiling fallback.
export const engineBitrateSchema = z.object({
	/** What the adaptive controller has set the encoder to right now, kbps. */
	applied_kbps: z.number().nonnegative(),
	/** The ceiling the engine was started/reloaded with, kbps. */
	ceiling_kbps: z.number().nonnegative(),
});
export type EngineBitrate = z.infer<typeof engineBitrateSchema>;

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

// What the LIVE session's PREVIEW branch is actually encoding with (cerastream
// `PreviewEncoderRealized`, `status.preview_encoder_realized`). A sibling of
// `active_encode`, never nested inside it: preview and egress are different graph
// branches and are independently absent.
//
// Read `selected_element` and `realized_element` as a PAIR — that pairing is the
// whole informational content. `selected` absent + software realized means the
// board publishes no preview encoder at all; `selected` present + software
// realized with NO `fallback_reason` means the operator chose software on a
// capable board; the same pair WITH a reason is a genuine fallback.
//
// The field being ABSENT is a fourth, distinct reading — "no preview branch, or a
// legacy engine" — and is NOT `mode: "software"` and NOT
// `capabilities.preview.preview_hw_capability === false`. None of the four may be
// defaulted into another: doing so either hides a working control or offers one
// the board cannot honor. Additive + nullable + optional, so an engine that never
// reports it surfaces nothing at all.
export const previewEncodeFallbackSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('factory-missing') }),
	z.object({ code: z.literal('property-failure'), property: z.string() }),
]);
export type PreviewEncodeFallback = z.infer<typeof previewEncodeFallbackSchema>;

export const previewEncoderRealizedSchema = z.object({
	/** Element the board's HAL descriptor publishes; absent ⇒ it publishes none. */
	selected_element: z.string().optional(),
	/** Element actually built into the preview branch, e.g. "x264enc". */
	realized_element: z.string(),
	/** The encoder family actually realized — the ACTIVE mode, never the request. */
	mode: z.enum(['software', 'hardware']),
	/** Why a hardware request is running in software; absent is the normal case. */
	fallback_reason: previewEncodeFallbackSchema.optional(),
});
export type PreviewEncoderRealized = z.infer<typeof previewEncoderRealizedSchema>;

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
	// protocol). Additive-optional, present ONLY when true — which is safe here
	// because `status` entries are replaced wholesale, unlike the `netif` merge
	// that made `policy_route_missing` need an explicit `false` to retract.
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
	resolved_asrc_candidates: z.array(z.string()).nullable().optional(),
	pending_audio_follow_asrc: z.string().nullable().optional(),
	set_password: z.boolean().optional(),
	remote: remoteStatusSchema.optional(),
	linkTelemetry: linkTelemetryMessageSchema.nullable().optional(),
	buffering: bufferingStatusSchema.nullable().optional(),
	active_encode: activeEncodeSchema.nullable().optional(),
	engine_bitrate: engineBitrateSchema.nullable().optional(),
	preview_encoder_realized: previewEncoderRealizedSchema.nullable().optional(),
	network_ingest: networkIngestSchema.nullable().optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
