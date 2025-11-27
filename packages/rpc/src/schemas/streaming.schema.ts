/**
 * Streaming configuration and status Zod schemas
 */
import { z } from 'zod';

// Audio codec enum
export const audioCodecSchema = z.enum(['opus', 'aac', 'pcm']);
export type AudioCodec = z.infer<typeof audioCodecSchema>;

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

// Pipeline schema
export const pipelineSchema = z.object({
	name: z.string(),
	asrc: z.boolean(),
	acodec: z.boolean(),
});
export type Pipeline = z.infer<typeof pipelineSchema>;

// Pipelines message schema
export const pipelinesSchema = z.record(z.string(), pipelineSchema);
export type Pipelines = z.infer<typeof pipelinesSchema>;

// Audio codecs message schema
export const audioCodecsMessageSchema = z.record(audioCodecSchema, z.string());
export type AudioCodecsMessage = z.infer<typeof audioCodecsMessageSchema>;

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
