/**
 * Streaming Procedures
 * Wraps existing streaming logic from modules/streaming/
 */

import {
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	pipelinesSchema,
	streamingConfigInputSchema,
	streamingStartOutputSchema,
	streamingStopOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { getConfig } from "../../modules/config.ts";
import { audioCodecs } from "../../modules/streaming/audio.ts";
import { setBitrate as setEncoderBitrate } from "../../modules/streaming/encoder.ts";
import { getPipelineList } from "../../modules/streaming/pipelines.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import {
	start as startStream,
	stop as stopStream,
} from "../../modules/streaming/streamloop.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Start streaming procedure
 */
export const streamingStartProcedure = authedProcedure
	.input(streamingConfigInputSchema)
	.output(streamingStartOutputSchema)
	.handler(async ({ input, context }) => {
		try {
			// The existing start function handles validation and config saving
			// We need to adapt it to work with our context
			await startStream(context.ws as unknown as import("ws").default, {
				start: input,
			});
			return { success: true, is_streaming: getIsStreaming() };
		} catch (error) {
			return { success: false, is_streaming: false };
		}
	});

/**
 * Stop streaming procedure
 */
export const streamingStopProcedure = authedProcedure
	.output(streamingStopOutputSchema)
	.handler(() => {
		stopStream();
		return { success: true };
	});

/**
 * Set bitrate procedure
 */
export const setBitrateProcedure = authedProcedure
	.input(bitrateInputSchema)
	.output(bitrateOutputSchema)
	.handler(({ input }) => {
		if (getIsStreaming()) {
			const newBitrate = setEncoderBitrate({ bitrate: input });
			if (newBitrate) {
				return { max_br: newBitrate };
			}
		}
		return { max_br: input.max_br };
	});

/**
 * Get pipelines procedure
 */
export const getPipelinesProcedure = authedProcedure
	.output(pipelinesSchema)
	.handler(() => {
		return getPipelineList();
	});

/**
 * Get audio codecs procedure
 */
export const getAudioCodecsProcedure = authedProcedure
	.output(audioCodecsMessageSchema)
	.handler(() => {
		return audioCodecs;
	});

/**
 * Get current config procedure
 */
export const getConfigProcedure = authedProcedure
	.output(configMessageSchema)
	.handler(() => {
		const config = getConfig();
		return {
			asrc: config.asrc,
			max_br: config.max_br,
			acodec: config.acodec as "opus" | "aac" | "pcm" | undefined,
			delay: config.delay,
			pipeline: config.pipeline,
			srt_latency: config.srt_latency,
			bitrate_overlay: config.bitrate_overlay,
			srtla_addr: config.srtla_addr,
			srtla_port: config.srtla_port,
			srt_streamid: config.srt_streamid,
			remote_key: config.remote_key,
			relay_account: config.relay_account,
			relay_server: config.relay_server,
		};
	});
