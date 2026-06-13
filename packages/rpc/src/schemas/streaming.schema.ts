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

export const AUDIO_DELAY_MIN = -2000;
export const AUDIO_DELAY_MAX = 2000;

// Canonical SRTLA/SRT port range. FE port validation derives from these via the
// ValidationAdapter (no inline literals); srtla_port below references them too.
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

// Audio codec enum
export const audioCodecSchema = z.enum(['opus', 'aac', 'pcm']);
export type AudioCodec = z.infer<typeof audioCodecSchema>;

// Alias for frontend compatibility
export type AudioCodecs = 'aac' | 'opus';

// Resolution and framerate types for pipeline overrides
export const resolutionSchema = z.enum(['480p', '720p', '1080p', '1440p', '2160p', '4k']);
export type Resolution = z.infer<typeof resolutionSchema>;

export const framerateSchema = z.union([
	z.literal(25),
	z.literal(29.97),
	z.literal(30),
	z.literal(50),
	z.literal(59.94),
	z.literal(60),
]);
export type Framerate = z.infer<typeof framerateSchema>;

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
	asrc: z.string().optional(),
	bitrate_overlay: z.boolean().optional(),
	max_br: z.number().int().min(BITRATE_MIN).max(BITRATE_MAX).optional(),
	autostart: z.boolean().optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
});
export type StreamingConfigInput = z.infer<typeof streamingConfigInputSchema>;

// Bitrate input schema
export const bitrateInputSchema = z.object({
	max_br: z.number().int().min(BITRATE_MIN).max(BITRATE_MAX),
});
export type BitrateInput = z.infer<typeof bitrateInputSchema>;

// Bitrate output schema — returns applied max_br after hardware clamp
export const bitrateOutputSchema = z.object({
	max_br: z.number(),
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
	libuvch264: 'UVC H264 Camera',
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

// Pipeline schema - now based on video sources with structured metadata
export const pipelineSchema = z.object({
	name: z.string(),
	description: z.string(),
	supportsAudio: z.boolean(),
	supportsResolutionOverride: z.boolean(),
	supportsFramerateOverride: z.boolean(),
	defaultResolution: resolutionSchema.optional(),
	defaultFramerate: framerateSchema.optional(),
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

export const capabilitiesMessageSchema = z.object({
	platform: platformCapsSchema,
	encoder: encoderCapsSchema,
	sources: z.array(videoSourceCapSchema),
	engineUnavailable: z.boolean().optional(),
	engineStarting: z.boolean().optional(),
	schemaVersionMismatch: z.boolean().optional(),
});
export type CapabilitiesMessage = z.infer<typeof capabilitiesMessageSchema>;

// Available resolutions for UI
export const AVAILABLE_RESOLUTIONS: Resolution[] = ['480p', '720p', '1080p', '1440p', '2160p'];

// Available framerates for UI
export const AVAILABLE_FRAMERATES: Framerate[] = [25, 29.97, 30, 50, 59.94, 60];

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
import { relayProtocolSchema } from './relay.schema';

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
	detectionMethod: detectionMethodSchema.optional(),
	resolution: resolutionSchema.optional(),
	framerate: framerateSchema.optional(),
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

// Streaming setConfig output — includes applied config fields post-clamp
export const streamingSetConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: streamingConfigInputSchema.partial().optional(),
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

export const streamHealthOutputSchema = z.object({
	state: healthStateSchema,
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

export const deviceKindSchema = z.enum(['hdmi', 'usb', 'network', 'test', 'audio', 'other']);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

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
});
export type SwitchInputOutput = z.infer<typeof switchInputOutputSchema>;

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
