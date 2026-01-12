/**
 * Streaming configuration and status Zod schemas
 */
import { z } from 'zod';

// Audio codec enum
export const audioCodecSchema = z.enum(['opus', 'aac', 'pcm']);
export type AudioCodec = z.infer<typeof audioCodecSchema>;

// Alias for frontend compatibility
export type AudioCodecs = 'aac' | 'opus';

// Streaming configuration input schema
export const streamingConfigInputSchema = z.object({
	delay: z.number().int().min(-2000).max(2000).optional(),
	srt_latency: z.number().int().min(100).max(10000).optional(),
	pipeline: z.string().optional(),
	acodec: audioCodecSchema.optional(),
	relay_server: z.string().optional(),
	relay_account: z.string().optional(),
	srtla_addr: z.string().optional(),
	srtla_port: z.number().int().min(1).max(65535).optional(),
	srt_streamid: z.string().optional(),
	asrc: z.string().optional(),
	bitrate_overlay: z.boolean().optional(),
	max_br: z.number().int().min(500).max(50000).optional(),
	autostart: z.boolean().optional(),
});
export type StreamingConfigInput = z.infer<typeof streamingConfigInputSchema>;

// Bitrate input schema
export const bitrateInputSchema = z.object({
	max_br: z.number().int().min(500).max(50000),
});
export type BitrateInput = z.infer<typeof bitrateInputSchema>;

// Bitrate output schema
export const bitrateOutputSchema = z.object({
	max_br: z.number(),
});
export type BitrateOutput = z.infer<typeof bitrateOutputSchema>;

// Resolution and framerate types for pipeline overrides
export const resolutionSchema = z.enum(["480p", "720p", "1080p", "1440p", "2160p", "4k"]);
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

// Hardware type schema
export const hardwareTypeSchema = z.enum(["jetson", "rk3588", "n100", "generic"]);
export type HardwareType = z.infer<typeof hardwareTypeSchema>;

// Hardware labels (browser-safe, no Node deps)
export const HARDWARE_LABELS: Record<HardwareType, string> = {
	jetson: "NVIDIA Jetson",
	rk3588: "Rockchip RK3588",
	n100: "Intel N100",
	generic: "Generic (Software)",
};

// Hardware descriptions for UI
export const HARDWARE_DESCRIPTIONS: Record<HardwareType, string> = {
	jetson: "NVIDIA nvenc hardware encoding",
	rk3588: "Rockchip MPP hardware encoding (supports 4K)",
	n100: "Intel VAAPI hardware encoding",
	generic: "Software x264/x265 encoding",
};

// Hardware colors for UI (Tailwind classes)
export const HARDWARE_COLORS: Record<HardwareType, { text: string; bg: string; border: string }> = {
	jetson: {
		text: "text-green-600 dark:text-green-400",
		bg: "bg-green-500",
		border: "border-green-500 bg-green-500/20",
	},
	rk3588: {
		text: "text-orange-600 dark:text-orange-400",
		bg: "bg-orange-500",
		border: "border-orange-500 bg-orange-500/20",
	},
	n100: {
		text: "text-blue-600 dark:text-blue-400",
		bg: "bg-blue-500",
		border: "border-blue-500 bg-blue-500/20",
	},
	generic: {
		text: "text-gray-600 dark:text-gray-400",
		bg: "bg-gray-500",
		border: "border-gray-500 bg-gray-500/20",
	},
};

// Video source labels (browser-safe)
export const VIDEO_SOURCE_LABELS: Record<string, string> = {
	camlink: "Cam Link 4K",
	libuvch264: "UVC H264 Camera",
	hdmi: "HDMI Capture",
	usb_mjpeg: "USB MJPEG",
	v4l_mjpeg: "V4L2 MJPEG",
	rtmp: "RTMP Ingest",
	srt: "SRT Ingest",
	test: "Test Pattern",
	decklink: "Decklink SDI",
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

// Available resolutions for UI
export const AVAILABLE_RESOLUTIONS: Resolution[] = ["480p", "720p", "1080p", "1440p", "2160p"];

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

import { customProviderInputSchema, providerSelectionSchema } from './cloud-provider.schema';

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
	srtla_addr: z.string().optional(),
	srtla_port: z.number().optional(),
	srt_streamid: z.string().optional(),
	remote_key: z.string().optional(),
	remote_provider: providerSelectionSchema.optional(),
	custom_provider: customProviderInputSchema.optional(),
	relay_account: z.string().optional(),
	relay_server: z.string().optional(),
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
