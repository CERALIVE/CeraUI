/**
 * Streaming Procedures
 * Wraps existing streaming logic from modules/streaming/
 */

import {
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	getMockHardwareOutputSchema,
	pipelinesMessageSchema,
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	streamingConfigInputSchema,
	streamingStartOutputSchema,
	streamingStopOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { shouldUseMocks, setMockEncoderConfig, getMockState } from "../../mocks/mock-service.ts";
import { getConfig, saveConfig } from "../../modules/config.ts";
import { AUDIO_CODECS } from "@ceralive/ceracoder";
import { setBitrate as setEncoderBitrate } from "../../modules/streaming/encoder.ts";
import {
	getEffectiveHardware,
	getMockHardware,
	getPipelineList,
	getPipelinesMessage,
	initPipelines,
	setMockHardware,
	VALID_HARDWARE_TYPES,
} from "../../modules/streaming/pipelines.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import {
	start as startStream,
	stop as stopStream,
} from "../../modules/streaming/streamloop.ts";
import { broadcastMsg } from "../../modules/ui/websocket-server.ts";
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
			// Pass input directly - it already matches ConfigParameters
			await startStream(context.ws as unknown as import("ws").default, input);
			return { success: true, is_streaming: getIsStreaming() };
		} catch (_error) {
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
				if (shouldUseMocks()) {
					setMockEncoderConfig({ max_br: newBitrate });
				}
				return { max_br: newBitrate };
			}
		}
		if (shouldUseMocks()) {
			setMockEncoderConfig({ max_br: input.max_br });
		}
		return { max_br: input.max_br };
	});

/**
 * Get pipelines procedure - returns pipelines with hardware info
 */
export const getPipelinesProcedure = authedProcedure
	.output(pipelinesMessageSchema)
	.handler(() => {
		return {
			hardware: getEffectiveHardware(),
			pipelines: getPipelineList(),
		};
	});

/**
 * Get audio codecs procedure
 */
export const getAudioCodecsProcedure = authedProcedure
	.output(audioCodecsMessageSchema)
	.handler(() => {
		return AUDIO_CODECS;
	});

/**
 * Get current config procedure
 */
export const getConfigProcedure = authedProcedure
	.output(configMessageSchema)
	.handler(() => {
		const config = getConfig();
		let max_br = config.max_br;

		// In mock mode, overlay mockEncoderConfig.max_br if set
		if (shouldUseMocks()) {
			const mockState = getMockState();
			if (mockState.mockEncoderConfig.max_br !== undefined) {
				max_br = mockState.mockEncoderConfig.max_br;
			}
		}

		return {
			asrc: config.asrc,
			max_br,
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

/**
 * Persist streaming/server configuration without starting the stream.
 * Mirrors the config-write + relay/manual mutual-exclusion of streaming's
 * updateConfig, minus the DNS resolution and pipeline requirements that only
 * apply when actually launching a stream.
 */
export const setConfigProcedure = authedProcedure
	.input(streamingConfigInputSchema)
	.output(streamingStopOutputSchema)
	.handler(({ input }) => {
		const config = getConfig();

		if (input.srt_latency !== undefined) config.srt_latency = input.srt_latency;
		if (input.delay !== undefined) config.delay = input.delay;
		if (input.pipeline !== undefined) config.pipeline = input.pipeline;
		if (input.acodec !== undefined) config.acodec = input.acodec;
		if (input.asrc !== undefined) config.asrc = input.asrc;
		if (input.max_br !== undefined) config.max_br = input.max_br;
		if (input.bitrate_overlay !== undefined)
			config.bitrate_overlay = input.bitrate_overlay;

		if (input.relay_server) {
			config.relay_server = input.relay_server;
			config.srtla_addr = undefined;
			config.srtla_port = undefined;
		} else if (input.srtla_addr) {
			config.srtla_addr = input.srtla_addr;
			config.srtla_port = input.srtla_port;
			config.relay_server = undefined;
		}

		if (input.relay_account) {
			config.relay_account = input.relay_account;
			config.srt_streamid = undefined;
		} else if (input.srt_streamid !== undefined) {
			config.srt_streamid = input.srt_streamid;
			config.relay_account = undefined;
		}

		saveConfig();
		broadcastMsg("config", config);
		return { success: true };
	});

/**
 * Set mock hardware procedure (dev-only)
 * Changes the active hardware type and reloads/broadcasts pipelines
 */
export const setMockHardwareProcedure = authedProcedure
	.input(setMockHardwareInputSchema)
	.output(setMockHardwareOutputSchema)
	.handler(({ input }) => {
		// Only allow in development/mock mode
		if (!shouldUseMocks()) {
			return {
				success: false,
				error: "Mock hardware switching only available in development mode",
			};
		}

		const success = setMockHardware(input.hardware);
		if (success) {
			// Reload pipelines and broadcast to all clients
			initPipelines();
			broadcastMsg("pipelines", getPipelinesMessage());
			return {
				success: true,
				hardware: input.hardware,
			};
		}

		return {
			success: false,
			error: `Invalid hardware type: ${input.hardware}`,
		};
	});

/**
 * Get mock hardware state procedure (dev-only)
 */
export const getMockHardwareProcedure = authedProcedure
	.output(getMockHardwareOutputSchema)
	.handler(() => {
		return {
			hardware: getMockHardware(),
			effectiveHardware: getEffectiveHardware(),
			availableHardware: [...VALID_HARDWARE_TYPES],
		};
	});
