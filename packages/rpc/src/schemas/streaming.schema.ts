/**
 * Streaming configuration and status Zod schemas
 */
import { z } from 'zod';

/**
 * Canonical bitrate range — SINGLE SOURCE OF TRUTH (Task 14).
 *
 * DECISION: keep the hardware-accurate range (500–50000 kbps) as the canonical
 * VALIDATION bound applied on both FE + BE. The encoder engine can legitimately
 * drive bitrates across this full window, so rejecting values inside it would drop
 * valid hardware states. The narrower 2000–12000 window is the PRACTICAL UI DEFAULT
 * used to seed the slider — it is a UX hint, NOT a validation gate.
 *
 * - BITRATE_MIN / BITRATE_MAX            → hardware limit, used by zod validation.
 * - BITRATE_DEFAULT_MIN / BITRATE_DEFAULT_MAX → practical slider default for the UI.
 *
 * FE slider bounds + FE validation MUST derive from these constants (no literals).
 */
export const BITRATE_MIN = 500;
export const BITRATE_MAX = 50000;
export const BITRATE_DEFAULT_MIN = 2000;
export const BITRATE_DEFAULT_MAX = 12000;

export const SRT_LATENCY_MIN = 100;
export const SRT_LATENCY_MAX = 10000;

// SRTLA egress latency FLOOR (T2). The schema VALIDATION min stays at
// SRT_LATENCY_MIN (100) so a legacy sub-2s config still parses on boot — do NOT
// raise it — but the effective latency is floored to this value at every layer
// (FE slider, backend setConfig/start clamps, device.setProfile, config load).
export const SRTLA_MIN_LATENCY_MS = 2000;

export const AUDIO_DELAY_MIN = -2000;
export const AUDIO_DELAY_MAX = 2000;

// Canonical SRTLA/SRT port range. FE port validation derives from these via the
// ValidationAdapter (no inline literals); srtla_port below references them too.
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

// Audio codec enum. `pcm` was retired in C5 (coherence-contract-pass): it was
// never a real egress codec — no relay transport can carry raw PCM (all three
// are MPEG-TS) — so it only ever caused schema-vs-catalog drift. A persisted
// legacy `acodec: "pcm"` is coerced to "aac" at config load (backend
// `coerceLegacyAcodec`); this enum is now the strict egress set.
export const audioCodecSchema = z.enum(['opus', 'aac']);
export type AudioCodec = z.infer<typeof audioCodecSchema>;

// Alias for frontend compatibility
export type AudioCodecs = 'aac' | 'opus';

// ─── Transport × audio-codec compatibility (C5) ──────────────────────────────
//
// Every relay transport CeraUI can egress over — srtla, srt, and rist — is an
// MPEG-TS carrier, and the BELABOX-lineage / OBS receivers on the far end expect
// AAC-in-TS. The engine's Opus path (`opusenc`) has ZERO golden coverage
// (cerastream `docs/CRATES.md`), so Opus egress is unproven end-to-end over any
// of these transports. This map is the SINGLE source of truth for which audio
// codecs are allowed per relay transport: the backend `streaming.start` gate
// reads it, and the frontend `ValidationAdapter` re-exports the helper to gate
// the codec picker (todo 21). Do not hardcode this map anywhere outside this
// package.
export const TRANSPORT_AUDIO_CODECS = {
	srtla: ['aac'],
	srt: ['aac'],
	rist: ['aac'],
} as const satisfies Record<RelayProtocol, readonly AudioCodec[]>;

// Stable structured code returned by streaming.start when the effective audio
// codec is not allowed for the effective relay transport.
export const AUDIO_CODEC_UNSUPPORTED_TRANSPORT = 'audio_codec_unsupported_transport';

/** True when `codec` may be carried over `protocol`'s MPEG-TS transport (C5). */
export function audioCodecAllowedForTransport(codec: AudioCodec, protocol: RelayProtocol): boolean {
	return (TRANSPORT_AUDIO_CODECS[protocol] as readonly AudioCodec[]).includes(codec);
}

// Typed audio-source model (Task 4/6). `id` is the EXACT current `asrc` wire string
// (e.g. "USB audio"), so `config.asrc` semantics are unchanged; `kind` distinguishes
// a real capture device from the two pseudo-sources; `labelKey` is an i18n key for
// the pseudo-sources only (device entries carry no key — hardware names are never
// translated). Broadcast beside the legacy `asrcs: string[]`, which REMAINS for
// back-compat. Additive + optional everywhere it is carried.
// Sentinel `asrc` wire value selecting the "Auto" audio source — the T5 resolver
// picks the concrete device at start/idle-preview (embedded → HDMI → Cam Link →
// USB → first-device → pipeline-default). Additive: the constant is the EXACT wire
// string, so `config.asrc === AUDIO_SOURCE_AUTO` opts into auto resolution.
export const AUDIO_SOURCE_AUTO = 'Auto';

// The `auto` kind (T5) is APPENDED to the existing variants: it tags the "Auto"
// pseudo-source. Existing variants (device/none/pipeline_default) are unchanged and
// in their original order, so a legacy audio-source list still parses.
export const audioSourceKindSchema = z.enum(['device', 'none', 'pipeline_default', 'auto']);
export type AudioSourceKind = z.infer<typeof audioSourceKindSchema>;

export const audioSourceSchema = z.object({
	id: z.string(),
	kind: audioSourceKindSchema,
	labelKey: z.string().optional(),
	// Verbatim hardware name for a device source (never translated). Additive +
	// optional: pseudo-sources (none/pipeline_default/auto) carry `labelKey`
	// instead; a legacy device entry with no label still parses.
	label: z.string().optional(),
});
export type AudioSource = z.infer<typeof audioSourceSchema>;

// Resolution and framerate types for pipeline overrides
export const resolutionSchema = z.enum(['480p', '720p', '1080p', '1440p', '2160p', '4k']);
export type Resolution = z.infer<typeof resolutionSchema>;

// Legal framerate rungs (VALIDATION / persistence ladder). 23.98 (24000/1001,
// NTSC-film) + 24 (cine) added so a device advertising film rates validates.
// `AVAILABLE_FRAMERATES` (the UI-offered + normalizer SNAP ladder below) is
// DELIBERATELY left at the pre-existing 6 rungs: adding the film rungs there would
// flip normalizeFramerateToRung('24000/1001')/(24) from the documented fail-closed
// `undefined` to a snapped value. Expanding that ladder is a downstream concern.
export const framerateSchema = z.union([
	z.literal(23.98),
	z.literal(24),
	z.literal(25),
	z.literal(29.97),
	z.literal(30),
	z.literal(50),
	z.literal(59.94),
	z.literal(60),
]);
export type Framerate = z.infer<typeof framerateSchema>;

// Egress video codec selection (Todo 19). Mirrors the cerastream StartParams
// `codec` wire enum (h264|h265). Additive/optional everywhere it is used — absent
// means "let the engine pick the platform default codec".
export const videoCodecSchema = z.enum(['h264', 'h265']);

export const videoPassthroughSchema = z.enum(['auto', 'force', 'off']);
export type VideoPassthrough = z.infer<typeof videoPassthroughSchema>;
export type VideoCodec = z.infer<typeof videoCodecSchema>;

// Resolution token ↔ engine "WxH" pixel-pair map (Todo 19). These dimensions MUST
// match cerastream's `Resolution::dims()` table EXACTLY
// (crates/cerastream-core/src/graph/spec.rs) so the device round-trips bijectively
// with the engine's realized encode dimensions (Todo 18 depends on this):
//   480p→852x480, 720p→1280x720, 1080p→1920x1080, 1440p→2560x1440, 2160p→3840x2160.
// '4k' is an ALIAS for '2160p': both map to "3840x2160" on toEngineResolution, but
// fromEngineResolution("3840x2160") returns ONLY the canonical '2160p' — never
// '4k'. This asymmetry is deliberate: canonical tokens are bijective; '4k' is a
// convenience alias that collapses onto '2160p' on the reverse mapping.
export const RESOLUTION_ENGINE_DIMS: Record<Resolution, string> = {
	'480p': '852x480',
	'720p': '1280x720',
	'1080p': '1920x1080',
	'1440p': '2560x1440',
	'2160p': '3840x2160',
	'4k': '3840x2160',
};

// Canonical reverse map — one canonical token per "WxH". '4k' is intentionally
// omitted so "3840x2160" resolves to the canonical '2160p' (documented asymmetry).
const ENGINE_DIMS_TO_RESOLUTION: Record<string, Resolution> = {
	'852x480': '480p',
	'1280x720': '720p',
	'1920x1080': '1080p',
	'2560x1440': '1440p',
	'3840x2160': '2160p',
};

/** Map a resolution token to the engine's "WxH" pixel form. Total on Resolution. */
export function toEngineResolution(token: Resolution): string {
	return RESOLUTION_ENGINE_DIMS[token];
}

/**
 * Map an engine "WxH" pixel form back to the canonical resolution token, or
 * `undefined` for an unknown dimension. Never returns '4k' (see the map comment).
 */
export function fromEngineResolution(wxh: string): Resolution | undefined {
	return ENGINE_DIMS_TO_RESOLUTION[wxh];
}

// Streaming configuration input schema
export const streamingConfigInputSchema = z.object({
	delay: z.number().int().min(AUDIO_DELAY_MIN).max(AUDIO_DELAY_MAX).optional(),
	srt_latency: z.number().int().min(SRT_LATENCY_MIN).max(SRT_LATENCY_MAX).optional(),
	pipeline: z.string().optional(),
	acodec: audioCodecSchema.optional(),
	relay_server: z.string().optional(),
	relay_account: z.string().optional(),
	relay_streamid_override: z.string().optional(),
	relay_protocol: relayProtocolSchema.optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().int().min(PORT_MIN).max(PORT_MAX).optional(),
	srt_streamid: z.string().optional(),
	// endpointId of the operator-selected platform-pushed ingest slot (T18/T19).
	// Identity is the endpointId, never host+port — the selection follows the
	// stable id across re-pushes that move the slot to a new host/port.
	selected_ingest_endpoint: z.string().optional(),
	asrc: z.string().optional(),
	bitrate_overlay: z.boolean().optional(),
	max_br: z.number().int().min(BITRATE_MIN).max(BITRATE_MAX).optional(),
	autostart: z.boolean().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
	// Operator-ordered video-source preference (input_id list, most-preferred
	// first). Governs operator-initiated switching only — the engine's
	// auto-failover is sticky and does NOT consult this list (Task 11).
	source_preference: z.array(z.string()).optional(),
	// Egress video codec + operator-selected video input_id (Todo 19). Both
	// additive/optional: absent codec → engine platform default; absent input →
	// engine default source. `selected_video_input` is a capture-device input_id.
	video_codec: videoCodecSchema.optional(),
	selected_video_input: z.string().optional(),
	// Same-codec passthrough policy (auto/force/off), sent to the engine at start
	// (cerastream Todo 16). Additive-optional; absent = auto.
	video_passthrough: videoPassthroughSchema.optional(),
	// Device-first operator source selection (StreamSource id, see
	// sources.schema.ts). The backend derives `pipeline` + `selected_video_input`
	// from it (T3). Additive-optional; absent = the legacy
	// pipeline/selected_video_input path. Carried here so oRPC input validation
	// accepts `setConfig({ source })` (T13) — the contract consumes this schema.
	source: z.string().optional(),
	// SRT receive-profile tuning (Tasks 18/19). FEC is device-side
	// SRTO_PACKETFILTER, only ever enabled against a FEC-capable CeraLive
	// receiver; recovery preference routes to the L1 (standard) vs L2/Classic
	// (bandwidth-saver) receiver listener. Both additive-optional.
	fec_enabled: z.boolean().optional(),
	recovery_mode: streamRecoveryPreferenceSchema.optional(),
});
export type StreamingConfigInput = z.infer<typeof streamingConfigInputSchema>;

// Bitrate input schema
export const bitrateInputSchema = z.object({
	max_br: z.number().int().min(BITRATE_MIN).max(BITRATE_MAX),
});
export type BitrateInput = z.infer<typeof bitrateInputSchema>;

// Bitrate output schema — contains-envelope (S3): { success } plus the applied
// bitrate (post hardware clamp) on success, or a structured error on failure.
// Clients lock the slider to `applied`, never to the value they sent.
export const bitrateOutputSchema = z.object({
	success: z.boolean(),
	applied: z.number().optional(),
	error: z.object({ message: z.string() }).optional(),
});
export type BitrateOutput = z.infer<typeof bitrateOutputSchema>;

// Hardware type schema
export const hardwareTypeSchema = z.enum(['jetson', 'rk3588', 'n100', 'generic']);
export type HardwareType = z.infer<typeof hardwareTypeSchema>;

// Hardware labels (browser-safe, no Node deps)
export const HARDWARE_LABELS: Record<HardwareType, string> = {
	jetson: 'NVIDIA Jetson',
	rk3588: 'Rockchip RK3588',
	n100: 'Intel N100',
	generic: 'Generic (Software)',
};

// Hardware descriptions for UI
export const HARDWARE_DESCRIPTIONS: Record<HardwareType, string> = {
	jetson: 'NVIDIA nvenc hardware encoding',
	rk3588: 'Rockchip MPP hardware encoding (supports 4K)',
	n100: 'Intel VAAPI hardware encoding',
	generic: 'Software x264/x265 encoding',
};

// Hardware colors for UI (Tailwind classes)
export const HARDWARE_COLORS: Record<HardwareType, { text: string; bg: string; border: string }> = {
	jetson: {
		text: 'text-green-600 dark:text-green-400',
		bg: 'bg-green-500',
		border: 'border-green-500 bg-green-500/20',
	},
	rk3588: {
		text: 'text-orange-600 dark:text-orange-400',
		bg: 'bg-orange-500',
		border: 'border-orange-500 bg-orange-500/20',
	},
	n100: {
		text: 'text-blue-600 dark:text-blue-400',
		bg: 'bg-blue-500',
		border: 'border-blue-500 bg-blue-500/20',
	},
	generic: {
		text: 'text-gray-600 dark:text-gray-400',
		bg: 'bg-gray-500',
		border: 'border-gray-500 bg-gray-500/20',
	},
};

// Video source labels (browser-safe)
export const VIDEO_SOURCE_LABELS: Record<string, string> = {
	camlink: 'Cam Link 4K',
	libuvch264: 'USB camera with hardware H.264 (UVC)',
	uvc_h264: 'UVC H.264 Camera',
	uvc_h265: 'UVC H.265 Camera',
	hdmi: 'HDMI Capture',
	usb_mjpeg: 'USB MJPEG',
	v4l_mjpeg: 'V4L2 MJPEG',
	rtmp: 'RTMP Ingest',
	srt: 'SRT Ingest',
	test: 'Test Pattern',
	decklink: 'Decklink SDI',
};

// Network-ingest gateway kinds (Task 17). A pipeline whose source is a local
// ingest server (rtmp/srt) only encodes once its corresponding gateway is up, so
// the entry carries the gateway kind it depends on. Additive/optional everywhere:
// absent means "no gateway dependency" (a direct-capture source like hdmi).
export const requiresGatewaySchema = z.enum(['rtmp', 'srt']);
export type RequiresGateway = z.infer<typeof requiresGatewaySchema>;

// Stable structured code returned by streaming.start when an rtmp/srt pipeline is
// started while its network-ingest gateway is inactive. The frontend maps it to a
// disabled-with-reason / start-blocked message (never a raw string).
export const GATEWAY_INACTIVE_ERROR = 'network_ingest_gateway_inactive';

// Per-pipeline audio provenance (Task 4/13). `selectable` = ALSA/device audio the
// operator picks (the legacy behavior); `embedded` = audio muxed into the incoming
// network stream (rtmp/srt); `none` = the pipeline carries no audio. Additive +
// optional: absent means the pipeline follows the legacy selectable-audio behavior.
export const pipelineAudioKindSchema = z.enum(['selectable', 'embedded', 'none']);
export type PipelineAudioKind = z.infer<typeof pipelineAudioKindSchema>;

// Pipeline schema - now based on video sources with structured metadata
export const pipelineSchema = z.object({
	name: z.string(),
	description: z.string(),
	supportsAudio: z.boolean(),
	supportsResolutionOverride: z.boolean(),
	supportsFramerateOverride: z.boolean(),
	defaultResolution: resolutionSchema.optional(),
	defaultFramerate: framerateSchema.optional(),
	// Network-ingest gateway dependency (Task 17). Present only on rtmp/srt
	// pipelines; the gateway kind must be up before starting the pipeline.
	requires_gateway: requiresGatewaySchema.optional(),
	// Audio provenance for this pipeline (Task 4/13 registry field). Additive +
	// optional; rtmp/srt pipelines are 'embedded', direct-capture pipelines
	// 'selectable'. Absent → legacy selectable-audio behavior.
	audio_kind: pipelineAudioKindSchema.optional(),
});
export type Pipeline = z.infer<typeof pipelineSchema>;

// Pipelines message schema - includes hardware info
export const pipelinesMessageSchema = z.object({
	hardware: hardwareTypeSchema,
	pipelines: z.record(z.string(), pipelineSchema),
});
export type PipelinesMessage = z.infer<typeof pipelinesMessageSchema>;

// Legacy alias for backwards compatibility
export const pipelinesSchema = z.record(z.string(), pipelineSchema);
export type Pipelines = z.infer<typeof pipelinesSchema>;

// Capability contract broadcast (Option A: cerastream emits, CeraUI consumes).
// Mirrors the backend capability service (`modules/streaming/capabilities.ts`)
// and the pure `intersectCaps` input types. The encoder dialog reads it to clamp
// bitrate per-board, offer codecs (incl. generic/software H.265), and warn on
// software encode. Field names are snake_case to match the engine wire contract.
export const platformCapsSchema = z.object({
	supports_h265: z.boolean(),
	hardware_accelerated: z.boolean(),
	max_resolution: z.string(),
});

export const encoderCapsSchema = z.object({
	codecs: z.array(z.string()),
	bitrate_range: z.object({
		min: z.number(),
		max: z.number(),
		unit: z.string(),
	}),
});

export const videoSourceCapSchema = z.object({
	id: z.string(),
	supports_audio: z.boolean(),
	supports_resolution_override: z.boolean(),
	supports_framerate_override: z.boolean(),
	default_resolution: z.string(),
	default_framerate: z.number(),
});

// Per-device capture mode (Task 4). Mirrors one grouped entry derived from
// cerastream `captureDeviceSchema.caps[]` (docs/adr/schema.md:254-268): a concrete
// {width,height} plus the framerate rungs that device drives at it. `framerates` are
// NORMALIZED rung numbers (the engine emits string fractions like "30/1"; the backend
// folds + normalizes via normalizeFramerateToRung before broadcast). Additive +
// optional wherever it is carried.
export const deviceModeSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	framerates: z.array(z.number()),
	media_type: z.string().optional(),
});
export type DeviceMode = z.infer<typeof deviceModeSchema>;

// Capture-device kind namespace. Existing values are UNCHANGED and in their
// original order; the engine-typed capture kinds (uvc_h264/uvc_h265/mjpeg/camlink)
// are APPENDED (Todo 19) so a legacy device list still parses. Defined here (ahead
// of `deviceModeGroupSchema` + `captureDeviceSchema`) because both reference it.
export const deviceKindSchema = z.enum([
	'hdmi',
	'usb',
	'network',
	'test',
	'audio',
	'other',
	'uvc_h264',
	'uvc_h265',
	'mjpeg',
	'camlink',
]);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

// One device's mode group, keyed in `device_modes` by its list-devices input_id (the
// DEVICE id namespace, engine.rs:515-525 — DISTINCT from pipeline/source-kind ids).
// `kind` is the captureDeviceSchema kind that bridges the device id to a pipeline id
// (Oracle issue 4) — REQUIRED context because the two id namespaces differ. Typed as
// `deviceKindSchema` (C6) so the bridge value is a real device kind, not a raw string.
export const deviceModeGroupSchema = z.object({
	kind: deviceKindSchema.optional(),
	modes: z.array(deviceModeSchema),
});
export type DeviceModeGroup = z.infer<typeof deviceModeGroupSchema>;

export const capabilitiesMessageSchema = z.object({
	platform: platformCapsSchema,
	encoder: encoderCapsSchema,
	sources: z.array(videoSourceCapSchema),
	// Relay transports the engine can honor (e.g. ["srtla", "rist"]). Absent on
	// legacy snapshots → the consumer treats it as srtla-only (back-compat).
	transports: z.array(z.string()).optional(),
	engineUnavailable: z.boolean().optional(),
	engineStarting: z.boolean().optional(),
	schemaVersionMismatch: z.boolean().optional(),
	// Audio live-switch capability flag (Task 2). Absent on legacy snapshots →
	// the consumer treats it as false (back-compat). Only the engine advertises
	// this; the backend never synthesizes it.
	audio_live_switch: z.boolean().optional(),
	// SRT receive-profile capability advertised by the engine (cerastream Todo
	// 10). All ADDITIVE + OPTIONAL — absent on legacy snapshots, in which case
	// the Stream Tuning card treats the receiver as the Classic-only
	// (BELABOX-compatible) baseline. Field names are snake_case to match the
	// engine wire contract; the values are forwarded verbatim by the backend.
	supported_profiles: z.array(z.string()).optional(),
	profile_catalog_version: z.string().optional(),
	fec_capable: z.boolean().optional(),
	latency_range: z
		.object({
			min: z.number(),
			default: z.number(),
			max: z.number(),
		})
		.optional(),
	// Preview WebSocket availability (cerastream `PreviewAvailability`, Todo
	// 13-15). Additive + optional — absent on a legacy engine, in which case the
	// frontend treats preview as unavailable. Mirrors the additive-optional
	// pattern used by `latency_range` above; snake_case matches the engine wire.
	preview: z
		.object({
			enabled: z.boolean(),
			port: z.number().int().min(PORT_MIN).max(PORT_MAX).optional(),
			bound: z.boolean(),
		})
		.optional(),
	// Picture-in-picture / compositing capability flag. Additive + optional —
	// absent on every engine snapshot today, since the engine currently drives a
	// single active input (`fallbackswitch`, no compositor element). This is a
	// pure reservation: no procedure or UI reads this field yet. See TD-pip in
	// `docs/TECHNICAL_DEBT.md` (stays open) and the full evaluation record in
	// `docs/PIP_EVALUATION.md` for the delivery contract this flag is the first
	// layer of.
	pip_supported: z.boolean().optional(),
	// Per-device capture modes (Task 4), keyed by the device's list-devices
	// input_id; each entry carries the device `kind` (the bridge to a pipeline id)
	// and its concrete {width,height,framerates} modes. Additive + optional — an
	// engine that emits no per-device caps omits this and the UI falls back to the
	// coarse platform/source offering (byte-identical to today).
	device_modes: z.record(z.string(), deviceModeGroupSchema).optional(),
	// Embedded-audio routing capability (Task 4, mirrors todo 21's engine flag).
	// When true the engine can route the audio muxed into an rtmp/srt publish to the
	// encode leg; absent/false means it cannot (the current engine), so a
	// network-ingest pipeline stays on the legacy selectable-ALSA path. Additive +
	// optional.
	network_embedded_audio: z.boolean().optional(),
});
export type CapabilitiesMessage = z.infer<typeof capabilitiesMessageSchema>;

// ─── Preview WebSocket proxy — single-origin contract (Task 20) ──────────────
//
// The preview WebSocket is served by the cerastream engine on a loopback port,
// but the browser NEVER dials the engine directly. The CeraUI backend proxies it
// through its OWN origin at `PREVIEW_WS_PATH`, so the preview travels the same
// authenticated, single-origin path as the RPC socket (remote-access safe: no
// second port to expose, no CORS/mixed-origin concerns). Auth is a short-lived,
// single-use token minted over the authenticated RPC socket
// (`system.mintPreviewToken`) and passed as a query parameter — the stored
// password/RPC credentials never appear in the URL.
//
// The route ALWAYS upgrades on a pathname match and validates+consumes the token
// AFTER the upgrade (on open), closing with `PREVIEW_CLOSE_UNAUTHORIZED` when the
// token is invalid/expired/consumed — never a pre-upgrade HTTP refusal (a browser
// WebSocket cannot distinguish a pre-upgrade HTTP error from a network failure).

/** Dedicated upgrade path the backend forks BEFORE the oRPC WebSocket handler. */
export const PREVIEW_WS_PATH = '/preview';

/** Query-parameter name carrying the single-use preview token on the dial URL. */
export const PREVIEW_TOKEN_PARAM = 'token';

/**
 * Preview WebSocket close codes (application range 4000-4999, pinned here so the
 * backend proxy and the frontend `PreviewCanvas` agree on one contract).
 *  • `4401` — token invalid / expired / already consumed (auth failure on open).
 *  • `4502` — the engine's loopback preview socket is unreachable (engine down).
 *  • `4503` — the engine reports its preview endpoint unbound/disabled.
 */
export const PREVIEW_CLOSE_UNAUTHORIZED = 4401;
export const PREVIEW_CLOSE_UPSTREAM_DOWN = 4502;
export const PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE = 4503;

/** Output of `system.mintPreviewToken` — a single-use token + its TTL (ms). */
export const previewTokenOutputSchema = z.object({
	token: z.string(),
	ttlMs: z.number().int().positive(),
});
export type PreviewTokenOutput = z.infer<typeof previewTokenOutputSchema>;

// Available resolutions for UI
export const AVAILABLE_RESOLUTIONS: Resolution[] = ['480p', '720p', '1080p', '1440p', '2160p'];

// Available framerates for UI
export const AVAILABLE_FRAMERATES: Framerate[] = [25, 29.97, 30, 50, 59.94, 60];

// ─── Capability normalizers (Task 4) ────────────────────────────────────────
//
// Pure, browser-safe helpers mapping the engine's raw capability wire forms onto
// CeraUI's schema enums. normalizeFramerateToRung / normalizeResolutionToRung are
// FAIL-SAFE / fail-CLOSED: an unparseable or out-of-ladder value returns `undefined`
// (never a widened/guessed-up value), so a noisy engine payload can never WIDEN the
// offered set. normalizeBitrateRangeToKbps is the SINGLE unit-conversion seam.

// A device-caps framerate within this many fps of a rung snaps to it. Tight enough to
// separate 29.97 from 30 (0.03 apart) yet loose enough to absorb the NTSC rounding of
// the exact engine fractions (30000/1001 = 29.97003, 60000/1001 = 59.94006).
const FRAMERATE_MATCH_TOLERANCE = 0.01;

/** Parse a "num/den" fraction (or a plain numeric string) to a decimal, else undefined. */
function parseFramerateFraction(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}
	const fraction = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
	if (fraction) {
		const numerator = Number(fraction[1]);
		const denominator = Number(fraction[2]);
		if (denominator === 0) {
			return undefined;
		}
		return numerator / denominator;
	}
	const numeric = Number(trimmed);
	return Number.isNaN(numeric) ? undefined : numeric;
}

/**
 * Map an engine framerate to the legal `Framerate` rung, or `undefined`.
 *
 * The engine device caps emit STRING fraction framerates ("30/1", "30000/1001";
 * docs/adr/schema.md:259-264); a plain number is also accepted (passthrough when it is
 * already a legal rung). Maps "30/1"→30, "30000/1001"→29.97, "60000/1001"→59.94; a
 * value that snaps to no rung within tolerance (e.g. "7/3", "24000/1001") → `undefined`
 * (fail-closed — never guess a nearby rung).
 */
export function normalizeFramerateToRung(value: string | number): Framerate | undefined {
	const decimal = typeof value === 'number' ? value : parseFramerateFraction(value);
	if (decimal === undefined || !Number.isFinite(decimal)) {
		return undefined;
	}
	let nearest: Framerate | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const rung of AVAILABLE_FRAMERATES) {
		const distance = Math.abs(rung - decimal);
		if (distance < nearestDistance) {
			nearest = rung;
			nearestDistance = distance;
		}
	}
	return nearestDistance <= FRAMERATE_MATCH_TOLERANCE ? nearest : undefined;
}

// Resolution rungs keyed by pixel HEIGHT, ascending — the ladder a pixel-form
// resolution snaps DOWN to (never up).
const RESOLUTION_RUNG_BY_HEIGHT: ReadonlyArray<{ height: number; rung: Resolution }> = [
	{ height: 480, rung: '480p' },
	{ height: 720, rung: '720p' },
	{ height: 1080, rung: '1080p' },
	{ height: 1440, rung: '1440p' },
	{ height: 2160, rung: '2160p' },
];

/**
 * Map an engine resolution to a canonical `Resolution` rung, or `undefined`.
 *
 * Accepts BOTH rung forms ("2160p", "1080p", "4k"→'2160p') and pixel forms
 * ("3840x2160"→'2160p", "1920x1080"→'1080p'). An in-between pixel form snaps to the
 * nearest LOWER rung ("2000x1100"→'1080p'); a pixel form below the smallest rung and
 * any unparseable input → `undefined` (fail-closed — NEVER over-offers by rounding up).
 */
export function normalizeResolutionToRung(value: string): Resolution | undefined {
	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}
	const rung = resolutionSchema.safeParse(trimmed);
	if (rung.success) {
		return rung.data === '4k' ? '2160p' : rung.data;
	}
	const pixels = trimmed.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
	if (!pixels) {
		return undefined;
	}
	const height = Number(pixels[2]);
	if (!Number.isFinite(height)) {
		return undefined;
	}
	let snapped: Resolution | undefined;
	for (const candidate of RESOLUTION_RUNG_BY_HEIGHT) {
		if (height >= candidate.height) {
			snapped = candidate.rung;
		}
	}
	return snapped;
}

/** A bitrate window with an explicit unit — the wire shape of `encoder.bitrate_range`. */
export interface BitrateRange {
	min: number;
	max: number;
	unit: string;
}

/**
 * Normalize a wire bitrate range to kbps — the SINGLE conversion seam.
 *
 * The engine may emit `encoder.bitrate_range` in bps (500_000–20_000_000) or kbps;
 * CeraUI speaks kbps everywhere (BITRATE_MIN/BITRATE_MAX), so every consumer routes the
 * raw wire range through this helper. Only an explicit `unit: "bps"` is converted
 * (÷1000, rounded); any other unit is treated as already-kbps values and passed
 * through with the unit tagged `kbps`.
 */
export function normalizeBitrateRangeToKbps(range: BitrateRange): BitrateRange {
	if (range.unit === 'bps') {
		return {
			min: Math.round(range.min / 1000),
			max: Math.round(range.max / 1000),
			unit: 'kbps',
		};
	}
	return { min: range.min, max: range.max, unit: 'kbps' };
}

// Audio codecs message schema (objects with name field)
export const audioCodecsMessageSchema = z.record(
	audioCodecSchema,
	z.object({
		name: z.string(),
	}),
);
export type AudioCodecsMessage = z.infer<typeof audioCodecsMessageSchema>;

import {
	customProviderInputSchema,
	detectionMethodSchema,
	providerSelectionSchema,
} from './cloud-provider.schema';
import { type RelayProtocol, relayProtocolSchema } from './relay.schema';
import { sourcesVisibilitySchema } from './sources-visibility.schema';
import {
	resolverDecidedBySchema,
	streamProfileIdSchema,
	streamRecoveryPreferenceSchema,
} from './stream-profile.schema';

// Config message schema (what the server sends to clients)
export const configMessageSchema = z.object({
	asrc: z.string().optional(),
	ssh_pass: z.string().optional(),
	max_br: z.number().optional(),
	acodec: audioCodecSchema.optional(),
	delay: z.number().optional(),
	pipeline: z.string().optional(),
	srt_latency: z.number().optional(),
	bitrate_overlay: z.boolean().optional(),
	autostart: z.boolean().optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().optional(),
	srt_streamid: z.string().optional(),
	remote_key: z.string().optional(),
	remote_provider: providerSelectionSchema.optional(),
	custom_provider: customProviderInputSchema.optional(),
	relay_account: z.string().optional(),
	relay_server: z.string().optional(),
	relay_streamid_override: z.string().optional(),
	relay_protocol: relayProtocolSchema.optional(),
	// endpointId of the selected platform-pushed ingest slot (T18/T19), echoed
	// back so the UI can resolve the active slot's label and last-used selection.
	selected_ingest_endpoint: z.string().optional(),
	detectionMethod: detectionMethodSchema.optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
	// Operator-ordered video-source preference (input_id list, most-preferred
	// first) — echoed back so the UI can render the saved order (Task 11).
	source_preference: z.array(z.string()).optional(),
	// Egress video codec + operator-selected video input_id (Todo 19), echoed
	// back so the Live UI reflects the saved selection on reload.
	video_codec: videoCodecSchema.optional(),
	selected_video_input: z.string().optional(),
	// Same-codec passthrough policy, echoed so the Encoder dialog reflects the
	// saved auto/force/off on reload. Additive-optional (cerastream Todo 16).
	video_passthrough: videoPassthroughSchema.optional(),
	// Device-first operator source selection, echoed back so the UI reflects the
	// saved source on reload (T3/T13). Additive-optional.
	source: z.string().optional(),
	// SRT receive-profile tuning, echoed back so the card reflects the saved
	// values on reload (Tasks 18/19).
	fec_enabled: z.boolean().optional(),
	recovery_mode: streamRecoveryPreferenceSchema.optional(),
	// Active receive-profile preset id + who decided it, echoed so the card can
	// show the reconciled active profile and a "set by cloud · tap to override"
	// affordance when the cloud (operator/auto) pushed the profile (Task 21).
	stream_profile: streamProfileIdSchema.optional(),
	profile_decided_by: resolverDecidedBySchema.optional(),
	// Device-wide source-visibility flags, echoed so the Live source list and the
	// Sources dialog reflect the saved test-pattern visibility on reload. Written
	// only by streaming.setSourceVisibility (never streaming.setConfig).
	sources_visibility: sourcesVisibilitySchema.optional(),
});
export type ConfigMessage = z.infer<typeof configMessageSchema>;

// Streaming start output
export const streamingStartOutputSchema = z.object({
	success: z.boolean(),
	is_streaming: z.boolean().optional(),
});
export type StreamingStartOutput = z.infer<typeof streamingStartOutputSchema>;

// Streaming stop output
export const streamingStopOutputSchema = z.object({
	success: z.boolean(),
});
export type StreamingStopOutput = z.infer<typeof streamingStopOutputSchema>;

// Streaming setConfig output — includes applied config fields post-clamp, plus a
// stable structured `error` code (e.g. "unknown_source") returned when a setConfig
// carrying an unresolvable `source` is rejected (T3). Absent on success.
export const streamingSetConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: streamingConfigInputSchema.partial().optional(),
	error: z.string().optional(),
});
export type StreamingSetConfigOutput = z.infer<typeof streamingSetConfigOutputSchema>;

// Streaming start output extended — applied config fields post-clamp, plus a
// stable structured `error` code on a blocked start (e.g. a persisted pipeline
// the current hardware no longer offers).
export const streamingStartOutputSchemaExtended = z.object({
	success: z.boolean(),
	is_streaming: z.boolean().optional(),
	applied: streamingConfigInputSchema.partial().optional(),
	error: z.string().optional(),
});
export type StreamingStartOutputExtended = z.infer<typeof streamingStartOutputSchemaExtended>;

// ─── Stream health (Task 13) ────────────────────────────────────────────────
//
// Tri-state liveness rollup for the active stream, derived from process
// liveness, engine frame production, SRT reconnect status, and srtla bond
// link count. This is the device's single source of truth for "is the stream
// actually working". READ-ONLY — never drives restart logic.
export const healthStateSchema = z.enum(['healthy', 'degraded', 'dead']);
export type HealthState = z.infer<typeof healthStateSchema>;

// The single most-actionable cause behind a non-healthy state — `component`
// names the failing subsystem (`process` | `frames` | `links`), `detail` is a
// short operator-facing sentence (e.g. "1 of 3 links down"). Present only when
// the stream is degraded or dead; a healthy stream carries no reason.
export const streamHealthReasonSchema = z.object({
	component: z.string(),
	detail: z.string(),
});
export type StreamHealthReason = z.infer<typeof streamHealthReasonSchema>;

export const streamHealthOutputSchema = z.object({
	state: healthStateSchema,
	reason: streamHealthReasonSchema.optional(),
	process: z.object({
		alive: z.boolean(),
	}),
	frames: z.object({
		advancing: z.boolean(),
		count: z.number().int().nonnegative(),
	}),
	srt: z.object({
		reconnecting: z.boolean(),
		reconnectCount: z.number().int().nonnegative(),
	}),
	bond: z.object({
		linkCount: z.number().int().nonnegative(),
		activeLinks: z.number().int().nonnegative(),
	}),
});
export type StreamHealthOutput = z.infer<typeof streamHealthOutputSchema>;

// ─── Hotplug input picker + live switch (Task 34) ───────────────────────────
//
// `cerastream` is the only streaming engine; the schema stays so the wire shape
// (devices broadcast / getEngine RPC) is explicit and forward-extensible.
// Mirrors the backend `streamingEngineSchema`.
export const streamingEngineSchema = z.enum(['cerastream']);
export type StreamingEngineKind = z.infer<typeof streamingEngineSchema>;

// `deviceKindSchema` / `DeviceKind` are defined earlier in this file (ahead of
// `deviceModeGroupSchema`, which references the kind) — see that definition.

export const deviceMediaClassSchema = z.enum(['video', 'audio']);
export type DeviceMediaClass = z.infer<typeof deviceMediaClassSchema>;

export const captureCapSchema = z.object({
	width: z.number().int().optional(),
	height: z.number().int().optional(),
	framerate: z.string().optional(),
	// GStreamer media-type token (e.g. `video/x-h265`); additive, may be absent.
	media_type: z.string().optional(),
});
export type CaptureCap = z.infer<typeof captureCapSchema>;

// Mirrors the cerastream `captureDeviceSchema` plus two CeraUI-owned UI facets:
// `kind` for grouping and `lost` for the unplugged-during-session grace state.
export const captureDeviceSchema = z.object({
	input_id: z.string(),
	device_path: z.string(),
	display_name: z.string(),
	media_class: deviceMediaClassSchema,
	kind: deviceKindSchema,
	caps: z.array(captureCapSchema).optional(),
	lost: z.boolean().optional(),
});
export type CaptureDevice = z.infer<typeof captureDeviceSchema>;

export const devicesMessageSchema = z.object({
	engine: streamingEngineSchema,
	active_input: z.string().optional(),
	devices: z.array(captureDeviceSchema),
});
export type DevicesMessage = z.infer<typeof devicesMessageSchema>;

export const listDevicesOutputSchema = devicesMessageSchema;
export type ListDevicesOutput = DevicesMessage;

export const getEngineOutputSchema = z.object({ engine: streamingEngineSchema });
export type GetEngineOutput = z.infer<typeof getEngineOutputSchema>;

export const switchInputInputSchema = z.object({ input_id: z.string() });
export type SwitchInputInput = z.infer<typeof switchInputInputSchema>;

// `SOURCE_LOST` is the unplugged-during-switch race; callers surface it as a
// specific toast (never a generic error).
export const SWITCH_INPUT_ERRORS = {
	SOURCE_LOST: 'SOURCE_LOST',
	NOT_STREAMING: 'NOT_STREAMING',
	SWITCH_FAILED: 'SWITCH_FAILED',
} as const;
export const switchInputErrorSchema = z.enum([
	SWITCH_INPUT_ERRORS.SOURCE_LOST,
	SWITCH_INPUT_ERRORS.NOT_STREAMING,
	SWITCH_INPUT_ERRORS.SWITCH_FAILED,
]);
export type SwitchInputError = z.infer<typeof switchInputErrorSchema>;

export const switchInputOutputSchema = z.object({
	success: z.boolean(),
	active_input: z.string().optional(),
	gap_ms: z.number().int().nonnegative().optional(),
	error: switchInputErrorSchema.optional(),
	// Deferred-follow hint (T7): true when the audio source is following the video
	// input in Auto mode but the live follow could not be applied now and will be
	// applied at the next stream start. Additive + optional; absent = no deferral.
	audio_follow_pending: z.boolean().optional(),
});
export type SwitchInputOutput = z.infer<typeof switchInputOutputSchema>;

// ── Live audio source switch (Phase 1.5) ───────────────────────────────────
// Audio mirror of switchInput, gated on the engine's `audio_live_switch`
// capability. The engine returns a DISTINCT error for an unknown audio device
// (`cerastream.audio.device_not_found`, -32006) — never reuse the video
// SOURCE_LOST code. `mode` is optional (defaults to "manual" at the engine).
export const switchAudioInputSchema = z.object({
	audio_input_id: z.string(),
	mode: z.enum(['manual', 'auto']).optional(),
});
export type SwitchAudioInput = z.infer<typeof switchAudioInputSchema>;

// `AUDIO_DEVICE_NOT_FOUND` maps the engine's `cerastream.audio.device_not_found`
// (-32006); `SWITCH_FAILED` covers any other dispatch failure.
export const SWITCH_AUDIO_ERRORS = {
	AUDIO_DEVICE_NOT_FOUND: 'AUDIO_DEVICE_NOT_FOUND',
	NOT_STREAMING: 'NOT_STREAMING',
	SWITCH_FAILED: 'SWITCH_FAILED',
} as const;
export const switchAudioErrorSchema = z.enum([
	SWITCH_AUDIO_ERRORS.AUDIO_DEVICE_NOT_FOUND,
	SWITCH_AUDIO_ERRORS.NOT_STREAMING,
	SWITCH_AUDIO_ERRORS.SWITCH_FAILED,
]);
export type SwitchAudioError = z.infer<typeof switchAudioErrorSchema>;

export const switchAudioOutputSchema = z.object({
	success: z.boolean(),
	active_audio_input: z.string().optional(),
	gap_ms: z.number().int().nonnegative().optional(),
	error: switchAudioErrorSchema.optional(),
});
export type SwitchAudioOutput = z.infer<typeof switchAudioOutputSchema>;

// Live audio delay re-config (Phase 1.5) — hot-applies the audio delay via the
// engine's `reload-config.audio.delay_ms` (no stream restart). The bound mirrors
// the canonical AUDIO_DELAY_MAX; the engine clamps and echoes the applied value.
export const reloadAudioDelayInputSchema = z.object({
	delay_ms: z.number().int().min(0).max(AUDIO_DELAY_MAX),
});
export type ReloadAudioDelayInput = z.infer<typeof reloadAudioDelayInputSchema>;

export const reloadAudioDelayOutputSchema = z.object({
	success: z.boolean(),
	delay_ms: z.number().int().nonnegative().optional(),
	error: z.string().optional(),
});
export type ReloadAudioDelayOutput = z.infer<typeof reloadAudioDelayOutputSchema>;

// Dev-only mock hardware switcher schemas (includes generic for software fallback)
export const mockHardwareTypeSchema = z.enum(['jetson', 'n100', 'rk3588', 'generic']);
export type MockHardwareType = z.infer<typeof mockHardwareTypeSchema>;

export const setMockHardwareInputSchema = z.object({
	hardware: mockHardwareTypeSchema,
});
export type SetMockHardwareInput = z.infer<typeof setMockHardwareInputSchema>;

export const setMockHardwareOutputSchema = z.object({
	success: z.boolean(),
	hardware: mockHardwareTypeSchema.optional(),
	error: z.string().optional(),
});
export type SetMockHardwareOutput = z.infer<typeof setMockHardwareOutputSchema>;

export const getMockHardwareOutputSchema = z.object({
	hardware: mockHardwareTypeSchema.nullable(),
	effectiveHardware: z.string(),
	availableHardware: z.array(mockHardwareTypeSchema),
});
export type GetMockHardwareOutput = z.infer<typeof getMockHardwareOutputSchema>;

// Dev-only single-device unplug/replug seam (C7): detach/reattach ONE mock
// capture device by its list-devices input_id so e2e can drive the `lost` grace
// row (todo 11) + the `source_lost` start rejection (todo 12). No-op in prod.
export const setMockDeviceAttachedInputSchema = z.object({
	input_id: z.string().min(1),
	attached: z.boolean(),
});
export type SetMockDeviceAttachedInput = z.infer<typeof setMockDeviceAttachedInputSchema>;

export const setMockDeviceAttachedOutputSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
});
export type SetMockDeviceAttachedOutput = z.infer<typeof setMockDeviceAttachedOutputSchema>;
