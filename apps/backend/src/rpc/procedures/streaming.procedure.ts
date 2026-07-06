/**
 * Streaming Procedures
 * Wraps existing streaming logic from modules/streaming/
 */

import { CerastreamRpcError } from "@ceralive/cerastream";
import {
	AUDIO_SOURCE_AUTO,
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	GATEWAY_INACTIVE_ERROR,
	getEngineOutputSchema,
	getMockHardwareOutputSchema,
	listDevicesOutputSchema,
	pipelinesMessageSchema,
	reloadAudioDelayInputSchema,
	reloadAudioDelayOutputSchema,
	SRTLA_MIN_LATENCY_MS,
	type StreamingConfigInput,
	SWITCH_AUDIO_ERRORS,
	type SwitchInputOutput,
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	streamHealthOutputSchema,
	streamingConfigInputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
	streamingStopOutputSchema,
	switchAudioInputSchema,
	switchAudioOutputSchema,
	switchInputInputSchema,
	switchInputOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { logger } from "../../helpers/logger.ts";
import {
	getMockState,
	setMockEncoderConfig,
	setStreamingState,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import {
	clearMockStreamError,
	getInjectedMockStreamError,
	isMockGatewayActive,
} from "../../mocks/providers/streaming.ts";
import { getConfig, saveConfig } from "../../modules/config.ts";
import { reportActiveProfile } from "../../modules/remote-control/active-profile-reporter.ts";
import {
	getResolvedAsrc,
	refreshResolvedAsrcPreview,
	resolveAutoAsrcFromLiveState,
	setPendingAudioFollowAsrc,
} from "../../modules/streaming/auto-audio.ts";
import { mapCerastreamError } from "../../modules/streaming/cerastream-error-mapping.ts";
import { validatePersistedPipeline } from "../../modules/streaming/config-migration.ts";
import { deviceRegistry } from "../../modules/streaming/devices.ts";
import { clampBitrate } from "../../modules/streaming/encoder.ts";
import { isGatewayActive } from "../../modules/streaming/gateway-availability.ts";
import { getStreamHealth } from "../../modules/streaming/health.ts";
import { AUDIO_CODECS } from "../../modules/streaming/pipeline-sources.ts";
import {
	getEffectiveHardware,
	getMockHardware,
	getPipelineList,
	getPipelinesMessage,
	initPipelines,
	PipelineOverrideError,
	searchPipelines,
	setMockHardware,
	VALID_HARDWARE_TYPES,
	validatePipelineOverrides,
} from "../../modules/streaming/pipelines.ts";
import {
	broadcastSources,
	getSourcesMessage,
	type ResolveSourceRoutingResult,
	resolveSourceRouting,
} from "../../modules/streaming/sources.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../../modules/streaming/streaming.ts";
import {
	getConfiguredEngine,
	getStreamingBackend,
} from "../../modules/streaming/streaming-engine.ts";
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

// A second streaming.start arriving while the first is still launching is
// rejected with this stable code (not treated as a hard failure). The launch
// spawns srtla_send AND issues the engine IPC start, so running it twice would
// double-spawn the sender and double-start the engine.
const START_IN_PROGRESS = "START_IN_PROGRESS";

let startInFlight = false;

/**
 * Start streaming procedure
 */
export const streamingStartProcedure = authedProcedure
	.input(streamingConfigInputSchema)
	.output(streamingStartOutputSchemaExtended)
	.handler(async ({ input, context }) => {
		if (startInFlight) {
			return {
				success: false,
				is_streaming: getIsStreaming(),
				error: START_IN_PROGRESS,
			};
		}
		startInFlight = true;
		try {
			const applied: StreamingConfigInput = {
				...input,
				...(input.max_br !== undefined
					? { max_br: clampBitrate(input.max_br) }
					: {}),
				...(input.srt_latency !== undefined
					? { srt_latency: Math.max(input.srt_latency, SRTLA_MIN_LATENCY_MS) }
					: {}),
			};

			// Device-first source pre-validation (T3). Resolve the EFFECTIVE source
			// (this start's input, else the persisted post-coercion config.source)
			// HERE, before delegating: an unknown source rejects WITHOUT calling
			// session.start (session.ts swallows updateConfig errors, so the reject
			// must happen at this layer). A known source folds its derived pipeline +
			// recomputed selected_video_input into `applied` so the launch dispatches
			// the resolved pipeline through the existing offered-set gate below.
			const effectiveSource = input.source ?? getConfig().source;
			if (effectiveSource !== undefined) {
				const routed = resolveSourceRouting(
					effectiveSource,
					getSourcesMessage().sources,
				);
				if (!routed.ok) {
					return { success: false, is_streaming: false, error: routed.error };
				}
				applied.pipeline = routed.pipeline;
				applied.selected_video_input = routed.selected_video_input;
				applied.source = effectiveSource;
			}

			// Block start when the effective pipeline is not in the offered set — a
			// persisted pipeline the current hardware no longer offers. No silent
			// reset; the client surfaces the structured code so the operator re-picks.
			const effectivePipeline = applied.pipeline ?? getConfig().pipeline;
			if (effectivePipeline !== undefined) {
				const check = validatePersistedPipeline(
					effectivePipeline,
					Object.keys(getPipelineList()),
				);
				if (!check.valid) {
					return { success: false, is_streaming: false, error: check.error };
				}

				// Network-ingest pipelines (rtmp/srt) can only encode once their
				// local ingest gateway is up. The entry stays visible in the
				// registry (disabled-with-reason); block the start with a structured
				// code when the gateway is inactive. Mock honors a test-set flag;
				// real devices consult the gateway probe (Todo 16 seam).
				const requiresGateway =
					searchPipelines(effectivePipeline)?.requires_gateway;
				if (requiresGateway !== undefined) {
					const gatewayUp = shouldUseMocks()
						? isMockGatewayActive(requiresGateway)
						: isGatewayActive(requiresGateway);
					if (!gatewayUp) {
						return {
							success: false,
							is_streaming: false,
							error: GATEWAY_INACTIVE_ERROR,
						};
					}
				}
			}

			try {
				if (shouldUseMocks()) {
					// A test-injected Tier-2 error stands in for the engine refusing the
					// start on device: consume it once and surface the structured reason,
					// the same shape the real catch below returns.
					const injected = getInjectedMockStreamError();
					if (injected) {
						clearMockStreamError();
						return {
							success: false,
							is_streaming: false,
							error: mapCerastreamError(injected),
						};
					}
					// Dev has no srtla_send/cerastream binaries: the real start() flips
					// is_streaming on then immediately errors and flips it off. Simulate
					// a sustained stream so getIsStreaming() drives the UI as on device.
					setMockEncoderConfig({
						pipeline: applied.pipeline,
						bitrate_overlay: applied.bitrate_overlay,
						resolution: applied.resolution,
						framerate: applied.framerate,
						max_br: applied.max_br,
					});
					setStreamingState(true);
					updateStatus(true);
					return { success: true, is_streaming: getIsStreaming(), applied };
				}
				// The existing start function handles validation and config saving.
				// Pass the clamped copy so the persisted config matches the applied
				// state we report back.
				await startStream(
					context.ws as unknown as import("ws").default,
					applied,
				);
				return { success: true, is_streaming: getIsStreaming(), applied };
			} catch (error) {
				return {
					success: false,
					is_streaming: false,
					error: mapCerastreamError(error),
				};
			}
		} finally {
			startInFlight = false;
		}
	});

/**
 * Stop streaming procedure
 */
export const streamingStopProcedure = authedProcedure
	.output(streamingStopOutputSchema)
	.handler(() => {
		if (shouldUseMocks()) {
			// A deferred auto-audio follow only applies at the NEXT start; a stop
			// cancels it (mirrors the real stop path in streamloop's stop handler)
			// so the picker never keeps a stale "follows on restart" hint (T7).
			setPendingAudioFollowAsrc(null);
			setStreamingState(false);
			updateStatus(false);
			return { success: true };
		}
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
		const applied = clampBitrate(input.max_br);
		if (getIsStreaming()) {
			const newBitrate = getStreamingBackend().setBitrate({ max_br: applied });
			if (newBitrate) {
				if (shouldUseMocks()) {
					setMockEncoderConfig({ max_br: newBitrate });
				}
				return { success: true, applied: newBitrate };
			}
			// Streaming, but the engine refused the change — report a failure so the
			// client keeps its field lock instead of releasing to a bitrate the
			// engine never applied.
			return {
				success: false,
				error: { message: "Engine rejected the bitrate change" },
			};
		}
		if (shouldUseMocks()) {
			setMockEncoderConfig({ max_br: applied });
		}
		return { success: true, applied };
	});

/**
 * Get pipelines procedure - returns pipelines with hardware info
 */
export const getPipelinesProcedure = authedProcedure
	.output(pipelinesMessageSchema)
	.handler(() => {
		return getPipelinesMessage();
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
		let pipeline = config.pipeline;
		let bitrate_overlay = config.bitrate_overlay;
		let resolution = config.resolution;
		let framerate = config.framerate;

		// In mock mode, overlay mockEncoderConfig fields if set
		if (shouldUseMocks()) {
			const { mockEncoderConfig } = getMockState();
			if (mockEncoderConfig.max_br !== undefined)
				max_br = mockEncoderConfig.max_br;
			if (mockEncoderConfig.pipeline !== undefined)
				pipeline = mockEncoderConfig.pipeline;
			if (mockEncoderConfig.bitrate_overlay !== undefined)
				bitrate_overlay = mockEncoderConfig.bitrate_overlay;
			if (mockEncoderConfig.resolution !== undefined)
				resolution = mockEncoderConfig.resolution;
			if (mockEncoderConfig.framerate !== undefined)
				framerate = mockEncoderConfig.framerate;
		}

		return {
			asrc: config.asrc,
			max_br,
			acodec: config.acodec as "opus" | "aac" | "pcm" | undefined,
			delay: config.delay,
			pipeline,
			srt_latency: config.srt_latency,
			fec_enabled: config.fec_enabled,
			recovery_mode: config.recovery_mode,
			stream_profile: config.stream_profile,
			profile_decided_by: config.profile_decided_by,
			bitrate_overlay,
			resolution,
			framerate,
			video_codec: config.video_codec,
			selected_video_input: config.selected_video_input,
			source: config.source,
			source_preference: config.source_preference,
			srtla_addr: config.srtla_addr,
			srtla_port: config.srtla_port,
			srt_streamid: config.srt_streamid,
			remote_key: config.remote_key,
			relay_account: config.relay_account,
			relay_server: config.relay_server,
			relay_streamid_override: config.relay_streamid_override,
			relay_protocol: config.relay_protocol,
			selected_ingest_endpoint: config.selected_ingest_endpoint,
			detectionMethod: config.detectionMethod,
		};
	});

/**
 * Persist streaming/server configuration without starting the stream.
 * Validates pipeline overrides at save time (QW-I) — invalid overrides reject
 * the RPC with a typed error naming the offending field.
 * Mirrors the config-write + relay/manual mutual-exclusion of streaming's
 * updateConfig, minus the DNS resolution and pipeline requirements that only
 * apply when actually launching a stream.
 */
export const setConfigProcedure = authedProcedure
	.input(streamingConfigInputSchema)
	.output(streamingSetConfigOutputSchema)
	.handler(({ input }) => {
		const config = getConfig();

		// Device-first source selection (T3). Resolve at the PROCEDURE, BEFORE any
		// merge: an unknown source rejects with disk unchanged; a known source folds
		// its derived pipeline into `input` so the override-validation + merge below
		// see it. selected_video_input is recomputed on EVERY source write (persisted
		// further down) — the capture input_id, or cleared for a non-capture source.
		let sourceRouting:
			| Extract<ResolveSourceRoutingResult, { ok: true }>
			| undefined;
		if (input.source !== undefined) {
			const routed = resolveSourceRouting(
				input.source,
				getSourcesMessage().sources,
			);
			if (!routed.ok) {
				return { success: false, error: routed.error, applied: {} };
			}
			sourceRouting = routed;
			input.pipeline = routed.pipeline;
		}

		// Validate pipeline overrides at save time (QW-I)
		if (
			input.pipeline !== undefined ||
			input.resolution !== undefined ||
			input.framerate !== undefined
		) {
			const pipelineId = input.pipeline ?? config.pipeline;
			const pipeline = searchPipelines(pipelineId ?? "");
			if (pipeline) {
				try {
					validatePipelineOverrides(pipeline, {
						...(input.resolution !== undefined
							? { resolution: input.resolution }
							: {}),
						...(input.framerate !== undefined
							? { framerate: input.framerate }
							: {}),
					});
				} catch (err) {
					if (err instanceof PipelineOverrideError) {
						return {
							success: false,
							error: `Pipeline does not support ${err.field} override`,
							applied: {},
						};
					}
					throw err;
				}
			}
		}

		if (input.srt_latency !== undefined)
			config.srt_latency = Math.max(input.srt_latency, SRTLA_MIN_LATENCY_MS);
		if (input.fec_enabled !== undefined) config.fec_enabled = input.fec_enabled;
		if (input.recovery_mode !== undefined)
			config.recovery_mode = input.recovery_mode;
		if (input.delay !== undefined) config.delay = input.delay;
		if (input.pipeline !== undefined) config.pipeline = input.pipeline;
		if (input.acodec !== undefined) config.acodec = input.acodec;
		if (input.asrc !== undefined) config.asrc = input.asrc;
		if (input.max_br !== undefined) config.max_br = clampBitrate(input.max_br);
		if (input.resolution !== undefined) config.resolution = input.resolution;
		if (input.framerate !== undefined) config.framerate = input.framerate;
		if (input.video_codec !== undefined) config.video_codec = input.video_codec;
		if (input.source_preference !== undefined)
			config.source_preference = input.source_preference;
		if (input.selected_video_input !== undefined)
			config.selected_video_input = input.selected_video_input;
		// A resolved source overwrites selected_video_input verbatim (undefined
		// clears a stale capture input) and persists the operator's source id.
		if (sourceRouting !== undefined) {
			config.source = input.source;
			config.selected_video_input = sourceRouting.selected_video_input;
		}
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

		if (input.relay_streamid_override !== undefined)
			config.relay_streamid_override = input.relay_streamid_override;
		if (input.relay_protocol !== undefined)
			config.relay_protocol = input.relay_protocol;

		// Managed ingest-slot identity (Task 18). The slot path persists the slot's
		// endpointId; any other relay/manual save clears a stale slot (sent as '')
		// so deriveDestinationChoice re-derives correctly (round-3 mutual exclusion).
		if (input.selected_ingest_endpoint !== undefined) {
			config.selected_ingest_endpoint =
				input.selected_ingest_endpoint || undefined;
		} else if (
			input.relay_server !== undefined ||
			input.srtla_addr !== undefined
		) {
			config.selected_ingest_endpoint = undefined;
		}

		// Reflect the post-clamp config values back for every field the input
		// touched, so the FE field-lock releases on what the server actually wrote.
		const applied: StreamingConfigInput = {};
		if (input.srt_latency !== undefined)
			applied.srt_latency = config.srt_latency;
		if (input.fec_enabled !== undefined)
			applied.fec_enabled = config.fec_enabled;
		if (input.recovery_mode !== undefined)
			applied.recovery_mode = config.recovery_mode;
		if (input.delay !== undefined) applied.delay = config.delay;
		if (input.pipeline !== undefined) applied.pipeline = config.pipeline;
		if (input.acodec !== undefined) applied.acodec = config.acodec;
		if (input.asrc !== undefined) applied.asrc = config.asrc;
		if (input.max_br !== undefined) applied.max_br = config.max_br;
		if (input.resolution !== undefined) applied.resolution = config.resolution;
		if (input.framerate !== undefined) applied.framerate = config.framerate;
		if (input.video_codec !== undefined)
			applied.video_codec = config.video_codec;
		if (input.source_preference !== undefined)
			applied.source_preference = config.source_preference;
		if (input.selected_video_input !== undefined)
			applied.selected_video_input = config.selected_video_input;
		if (input.bitrate_overlay !== undefined)
			applied.bitrate_overlay = config.bitrate_overlay;
		if (input.relay_server !== undefined)
			applied.relay_server = config.relay_server;
		if (input.relay_account !== undefined)
			applied.relay_account = config.relay_account;
		if (input.srtla_addr !== undefined) applied.srtla_addr = config.srtla_addr;
		if (input.srtla_port !== undefined) applied.srtla_port = config.srtla_port;
		if (input.srt_streamid !== undefined)
			applied.srt_streamid = config.srt_streamid;
		if (input.relay_streamid_override !== undefined)
			applied.relay_streamid_override = config.relay_streamid_override;
		if (input.relay_protocol !== undefined)
			applied.relay_protocol = config.relay_protocol;
		if (input.selected_ingest_endpoint !== undefined)
			applied.selected_ingest_endpoint = config.selected_ingest_endpoint ?? "";
		if (sourceRouting !== undefined) {
			applied.source = input.source;
			applied.pipeline = config.pipeline;
			applied.selected_video_input = config.selected_video_input;
		}

		if (shouldUseMocks()) {
			setMockEncoderConfig({
				pipeline: applied.pipeline,
				bitrate_overlay: applied.bitrate_overlay,
				resolution: applied.resolution,
				framerate: applied.framerate,
				max_br: applied.max_br,
			});
		}

		saveConfig();
		broadcastMsg("config", config);
		reportActiveProfile();

		// A source/asrc change re-resolves the idle "Auto" preview (no-op unless
		// config.asrc is the sentinel; frozen while streaming).
		if (input.source !== undefined || input.asrc !== undefined) {
			refreshResolvedAsrcPreview();
		}
		return { success: true, applied };
	});

/**
 * Set mock hardware procedure (dev-only)
 * Changes the active hardware type and reloads/broadcasts pipelines
 */
export const setMockHardwareProcedure = authedProcedure
	.input(setMockHardwareInputSchema)
	.output(setMockHardwareOutputSchema)
	.handler(async ({ input }) => {
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
			await initPipelines();
			broadcastMsg("pipelines", getPipelinesMessage());
			broadcastSources();
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
 * Stream health procedure — read-only tri-state liveness rollup
 */
export const streamHealthProcedure = authedProcedure
	.output(streamHealthOutputSchema)
	.handler(() => {
		return getStreamHealth();
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

/**
 * Which engine the device runs — drives the frontend picker conditional.
 */
export const getEngineProcedure = authedProcedure
	.output(getEngineOutputSchema)
	.handler(() => {
		return { engine: getConfiguredEngine() };
	});

/**
 * List the live input sources (hotplug-aware picker). Read-only re-scan.
 */
export const listDevicesProcedure = authedProcedure
	.output(listDevicesOutputSchema)
	.handler(() => {
		return deviceRegistry.rescan();
	});

/**
 * After a SUCCESSFUL live video switchInput, make the switch DURABLE and surface a
 * deferred auto-audio follow (T7).
 *
 * (1) Persist the switched source. The device registry updates its `activeInput`
 * in memory only, so without this the next start would rehydrate the OLD source
 * from `config.source` and any "applies on next start" claim would be false.
 * `resolveSourceRouting` maps the switched id to its `{pipeline,
 * selected_video_input}`; an id that is not a known source is skipped with one
 * debug log (the live switch itself already succeeded).
 *
 * (2) Deferred auto-audio follow. cerastream's `switch-audio` drives only the two
 * pre-built graph legs, so a live device-keyed audio follow is not possible today
 * (TD-live-audio-follow) — the follow APPLIES AT NEXT START (T5's launch-time
 * resolution). In "Auto" mode, when the re-resolved target differs from the audio
 * the running stream is actually using (`resolved_asrc`, left untouched here), we
 * only broadcast the pending target and hint the caller. NEVER a switchAudio call.
 */
export function applySwitchInputFollow(
	inputId: string,
	result: SwitchInputOutput,
): SwitchInputOutput {
	if (!result.success) return result;

	const routed = resolveSourceRouting(inputId, getSourcesMessage().sources);
	if (!routed.ok) {
		logger.debug(
			"switchInput: switched input is not a known source; skipping durable persistence + audio follow",
			{ input_id: inputId, error: routed.error },
		);
		return result;
	}

	const config = getConfig();
	config.source = inputId;
	config.pipeline = routed.pipeline;
	config.selected_video_input = routed.selected_video_input;
	saveConfig();
	broadcastMsg("config", config);

	if (getConfig().asrc !== AUDIO_SOURCE_AUTO) return result;
	const next = resolveAutoAsrcFromLiveState();
	if (next.asrcKey === getResolvedAsrc()) return result;
	setPendingAudioFollowAsrc(next.asrcKey);
	return { ...result, audio_follow_pending: true };
}

/**
 * Live-switch the active input. Returns the glitch-free gap in ms, or a typed
 * error (SOURCE_LOST when the target was unplugged before the switch landed). A
 * successful switch is persisted + re-resolves the deferred Auto audio follow.
 */
export const switchInputProcedure = authedProcedure
	.input(switchInputInputSchema)
	.output(switchInputOutputSchema)
	.handler(async ({ input }) => {
		const result = await deviceRegistry.switchInput(input.input_id);
		return applySwitchInputFollow(input.input_id, result);
	});

/**
 * Live-switch the active audio source (Phase 1.5). Gated on the engine's
 * `audio_live_switch` capability (the frontend never offers this control until
 * the engine advertises it). Maps the engine's distinct
 * `cerastream.audio.device_not_found` to AUDIO_DEVICE_NOT_FOUND — never the
 * video SOURCE_LOST code.
 */
export const switchAudioProcedure = authedProcedure
	.input(switchAudioInputSchema)
	.output(switchAudioOutputSchema)
	.handler(async ({ input }) => {
		if (shouldUseMocks()) {
			return {
				success: true,
				active_audio_input: input.audio_input_id,
				gap_ms: 0,
			};
		}
		if (!getIsStreaming()) {
			return { success: false, error: SWITCH_AUDIO_ERRORS.NOT_STREAMING };
		}
		const started = performance.now();
		try {
			const { cerastreamBackend } = await import(
				"../../modules/streaming/cerastream-backend.ts"
			);
			const result = await cerastreamBackend.switchAudio({
				audio_input_id: input.audio_input_id,
				mode: input.mode ?? "manual",
			});
			const gap_ms = Math.max(0, Math.round(performance.now() - started));
			return {
				success: true,
				active_audio_input: result.active_audio_input,
				gap_ms,
			};
		} catch (err) {
			if (
				err instanceof CerastreamRpcError &&
				err.dataCode === "cerastream.audio.device_not_found"
			) {
				return {
					success: false,
					error: SWITCH_AUDIO_ERRORS.AUDIO_DEVICE_NOT_FOUND,
				};
			}
			return { success: false, error: SWITCH_AUDIO_ERRORS.SWITCH_FAILED };
		}
	});

/**
 * Hot-apply the audio delay (Phase 1.5) via reload-config — no stream restart.
 * The engine clamps and echoes the applied value.
 */
export const reloadAudioDelayProcedure = authedProcedure
	.input(reloadAudioDelayInputSchema)
	.output(reloadAudioDelayOutputSchema)
	.handler(async ({ input }) => {
		if (shouldUseMocks()) {
			return { success: true, delay_ms: input.delay_ms };
		}
		try {
			const { cerastreamBackend } = await import(
				"../../modules/streaming/cerastream-backend.ts"
			);
			const applied = await cerastreamBackend.reloadAudioDelay(input.delay_ms);
			return {
				success: true,
				delay_ms: applied.applied?.audio?.delay_ms ?? input.delay_ms,
			};
		} catch (_err) {
			return { success: false, error: "RELOAD_FAILED" };
		}
	});
