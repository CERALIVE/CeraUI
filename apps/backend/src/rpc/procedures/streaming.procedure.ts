/**
 * Streaming Procedures
 * Wraps existing streaming logic from modules/streaming/
 */

import { CerastreamRpcError } from "@ceralive/cerastream";
import {
	AUDIO_CODEC_UNSUPPORTED_TRANSPORT,
	AUDIO_SOURCE_AUTO,
	audioCodecAllowedForTransport,
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	GATEWAY_INACTIVE_ERROR,
	getEngineOutputSchema,
	getMockHardwareOutputSchema,
	type InputMode,
	listDevicesOutputSchema,
	pipelinesMessageSchema,
	reloadAudioDelayInputSchema,
	reloadAudioDelayOutputSchema,
	SRTLA_MIN_LATENCY_MS,
	type StartFailurePhase,
	type StartResult,
	type StreamingConfigInput,
	type StreamingSetConfigInput,
	type StreamSource,
	SWITCH_AUDIO_ERRORS,
	type SwitchInputOutput,
	setMockDeviceAttachedInputSchema,
	setMockDeviceAttachedOutputSchema,
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	setSourceVisibilityInputSchema,
	setSourceVisibilityOutputSchema,
	streamHealthOutputSchema,
	streamingConfigInputSchema,
	streamingSetConfigInputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
	streamingStopOutputSchema,
	switchAudioInputSchema,
	switchAudioOutputSchema,
	switchInputInputSchema,
	switchInputOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
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
	setMockDeviceAttached,
} from "../../mocks/providers/streaming.ts";
import { getConfig, saveConfig } from "../../modules/config.ts";
import { reportActiveProfile } from "../../modules/remote-control/active-profile-reporter.ts";
import { syncAudioMeterPreference } from "../../modules/streaming/audio-meter-bridge.ts";
import {
	getResolvedAsrc,
	refreshResolvedAsrcPreview,
	resolveAutoAsrcFromLiveState,
	setPendingAudioFollowAsrc,
} from "../../modules/streaming/auto-audio.ts";
import { mapCerastreamError } from "../../modules/streaming/cerastream-error-mapping.ts";
import { getApplyNowGate } from "../../modules/streaming/config-change-bridge.ts";
import {
	abandonStagedConfigChange,
	commitStagedConfigChange,
} from "../../modules/streaming/config-change-persistence.ts";
import {
	type StagedConfigFields,
	stageConfigChange,
} from "../../modules/streaming/config-change-staging.ts";
import { validatePersistedPipeline } from "../../modules/streaming/config-migration.ts";
import {
	DEVICE_MODE_UNSUPPORTED_ERROR,
	verifySaveDeviceMode,
} from "../../modules/streaming/device-mode-guard.ts";
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
	configuredSelectionAnchor,
	getSourcesMessage,
	noteSourceSelectionWrite,
	type ResolveSourceRoutingResult,
	resolveSelectionAnchor,
	resolveSourceIdentity,
	resolveSourceRouting,
} from "../../modules/streaming/sources.ts";
import {
	classifyStartFailure,
	newAttemptId,
	StreamStartFailure,
	typedStartFailure,
} from "../../modules/streaming/start-failure-taxonomy.ts";
import {
	startStreamSession,
	stopStreamSession,
} from "../../modules/streaming/stream-session-orchestrator.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import {
	getConfiguredEngine,
	getStreamingBackend,
} from "../../modules/streaming/streaming-engine.ts";
import { start as startStream } from "../../modules/streaming/streamloop.ts";
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

function throwStartFailure(
	phase: StartFailurePhase,
	error: unknown,
	attemptId: string,
): never {
	throw new StreamStartFailure(
		classifyStartFailure(phase, error, attemptId, {
			warn: (message, meta) => logger.warn(message, meta),
		}),
	);
}

function startResponse(
	result: StartResult,
	applied: StreamingConfigInput | undefined,
	legacyError: string | undefined,
) {
	switch (result.result) {
		case "started":
			return {
				success: true,
				is_streaming: getIsStreaming(),
				...(applied !== undefined ? { applied } : {}),
			};
		case "busy":
			return {
				...result,
				success: false,
				is_streaming: getIsStreaming(),
				error: START_IN_PROGRESS,
			};
		case "cancelled":
			return {
				...result,
				success: false,
				is_streaming: false,
				error: "START_CANCELLED",
			};
		case "failed":
			return {
				result: "failed" as const,
				attemptId: result.attemptId,
				failure: result.failure,
				success: false,
				is_streaming: false,
				error:
					legacyError ??
					(typeof result.failure.code === "string"
						? result.failure.code
						: result.failure.class),
			};
	}
}

/**
 * Start streaming procedure
 */
export const streamingStartProcedure = authedProcedure
	.input(streamingConfigInputSchema)
	.output(streamingStartOutputSchemaExtended)
	.handler(async ({ input, context }) => {
		let appliedResponse: StreamingConfigInput | undefined;
		let legacyError: string | undefined;
		const lifecycleResult = await startStreamSession({
			origin:
				context.ws.remoteAddress === "control-channel"
					? "remote-control"
					: "ui",
			launch: async ({ attemptId, generation }) => {
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
						getConfig().last_seen_devices,
						input.source === undefined
							? configuredSelectionAnchor(effectiveSource)
							: undefined,
					);
					if (!routed.ok) {
						legacyError = routed.error;
						throwStartFailure("params", new Error(routed.error), attemptId);
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
						legacyError = check.error;
						throwStartFailure("params", new Error(check.error), attemptId);
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
							legacyError = GATEWAY_INACTIVE_ERROR;
							throwStartFailure(
								"params",
								new Error(GATEWAY_INACTIVE_ERROR),
								attemptId,
							);
						}
					}
				}

				// Transport × audio-codec coherence gate (C5). Every relay transport is
				// an MPEG-TS carrier, so only AAC-in-TS is proven end-to-end; refuse an
				// effective codec the effective transport can't carry at START — config
				// SAVES stay permitted (mirrors the pipeline_not_in_offered_set gate).
				const effectiveAcodec = applied.acodec ?? getConfig().acodec;
				if (effectiveAcodec !== undefined) {
					const effectiveTransport =
						applied.relay_protocol ?? getConfig().relay_protocol ?? "srtla";
					if (
						!audioCodecAllowedForTransport(effectiveAcodec, effectiveTransport)
					) {
						legacyError = AUDIO_CODEC_UNSUPPORTED_TRANSPORT;
						throwStartFailure(
							"params",
							new Error(AUDIO_CODEC_UNSUPPORTED_TRANSPORT),
							attemptId,
						);
					}
				}

				if (shouldUseMocks()) {
					// A test-injected Tier-2 error stands in for the engine refusing the
					// start on device: consume it once and surface the structured reason,
					// the same shape the real catch below returns.
					const injected = getInjectedMockStreamError();
					if (injected) {
						clearMockStreamError();
						legacyError = mapCerastreamError(injected);
						throwStartFailure("start-rpc", injected, attemptId);
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
					appliedResponse = applied;
					return;
				}
				// The existing start function handles validation and config saving.
				// Pass the clamped copy so the persisted config matches the applied
				// state we report back.
				const startResult = await startStream(
					context.ws as unknown as import("ws").default,
					applied,
					generation,
					attemptId,
				);
				if (!startResult.success) {
					legacyError = startResult.error;
					if (startResult.failureClass !== undefined) {
						throw new StreamStartFailure(
							typedStartFailure(
								attemptId,
								startResult.phase,
								startResult.failureClass,
								startResult.error,
							),
						);
					}
					throwStartFailure(
						startResult.phase,
						new Error(startResult.error),
						attemptId,
					);
				}
				appliedResponse = applied;
			},
		});
		return startResponse(lifecycleResult, appliedResponse, legacyError);
	});

/**
 * Stop streaming procedure
 */
export const streamingStopProcedure = authedProcedure
	.output(streamingStopOutputSchema)
	.handler(async () => {
		if (shouldUseMocks()) {
			// A deferred auto-audio follow only applies at the NEXT start; a stop
			// cancels it (mirrors the real stop path in streamloop's stop handler)
			// so the picker never keeps a stale "follows on restart" hint (T7).
			setPendingAudioFollowAsrc(null);
			setStreamingState(false);
		}
		const result = await stopStreamSession("operator");
		return { ...result, success: result.result !== "stop_failed" };
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
				// The engine backend persisted config.max_br but nothing published
				// it — the one config write in the backend with no `config` echo.
				// Clients kept the pre-adjust bitrate cached, and the Live bitrate
				// control re-seeds from that cache on every mount (a destination
				// switch unmounts LiveView), so a hot-adjust visibly reverted on
				// tab-return while the device streamed on at the new rate.
				broadcastMsg("config", getConfig());
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
			acodec: config.acodec,
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
			video_passthrough: config.video_passthrough,
			selected_video_input: config.selected_video_input,
			source: config.source,
			// Travels with the `source` it is scoped to: `setConfig` and the
			// broadcast both carry it, and this PULL path used to omit it.
			input_mode: config.input_mode,
			previewEncode: config.previewEncode,
			source_preference: config.source_preference,
			sources_visibility: config.sources_visibility,
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
const APPLY_NOW_FIELDS = [
	"source",
	"resolution",
	"framerate",
	"video_codec",
	"input_mode",
] as const;

/**
 * Move the restart-requiring fields off `input` and into a staged marker,
 * returning `undefined` when this save is an ordinary "apply on next start".
 *
 * It MUTATES `input` on purpose: deleting the fields is what makes the existing
 * merge block below skip them, so there is exactly one place that decides
 * whether a value is persisted now — no parallel write path to drift.
 */
function stageApplyNowFields(
	input: StreamingSetConfigInput,
	config: RuntimeConfig,
	sourceRouting: Extract<ResolveSourceRoutingResult, { ok: true }> | undefined,
): StagedConfigFields | undefined {
	if (input.apply_now !== true) return undefined;
	if (!APPLY_NOW_FIELDS.some((field) => input[field] !== undefined))
		return undefined;
	if (!getApplyNowGate().isStreamLive()) return undefined;

	const candidate: StagedConfigFields = {
		...(input.source === undefined ? {} : { source: input.source }),
		...(input.resolution === undefined ? {} : { resolution: input.resolution }),
		...(input.framerate === undefined ? {} : { framerate: input.framerate }),
		...(input.video_codec === undefined
			? {}
			: { video_codec: input.video_codec }),
		...(input.input_mode === undefined ? {} : { input_mode: input.input_mode }),
		...(sourceRouting?.pipeline === undefined
			? {}
			: { pipeline: sourceRouting.pipeline }),
		...(sourceRouting?.selected_video_input === undefined
			? {}
			: { selected_video_input: sourceRouting.selected_video_input }),
	};
	const previous: StagedConfigFields = {
		...(config.source === undefined ? {} : { source: config.source }),
		...(config.resolution === undefined
			? {}
			: { resolution: config.resolution }),
		...(config.framerate === undefined ? {} : { framerate: config.framerate }),
		...(config.video_codec === undefined
			? {}
			: { video_codec: config.video_codec }),
		...(config.input_mode === undefined
			? {}
			: { input_mode: config.input_mode }),
		...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
		...(config.selected_video_input === undefined
			? {}
			: { selected_video_input: config.selected_video_input }),
	};

	stageConfigChange({
		attemptId: newAttemptId(),
		startedAt: Date.now(),
		candidate,
		previous,
	});

	for (const field of APPLY_NOW_FIELDS) delete input[field];
	if (sourceRouting !== undefined) delete input.pipeline;

	return candidate;
}

/**
 * The typed refusal for an `input_mode` the selected device does not advertise.
 * A stable wire value — the picker keys its honest rejection copy on it.
 */
export const INPUT_MODE_UNSUPPORTED_ERROR = "input_mode_unsupported";

type InputModeChoice =
	| { ok: true; inputMode: InputMode | undefined }
	| { ok: false; error: typeof INPUT_MODE_UNSUPPORTED_ERROR };

/**
 * Which capture format this save lands on, and whether the device can honour it.
 *
 * Two asymmetries are load-bearing.
 *
 * A mode is scoped to the HARDWARE it was chosen for, decided by stable identity
 * rather than node path — the kernel recycles `/dev/videoN`, so a path match
 * proves nothing about which camera is being pointed at. Selecting a different
 * device therefore DROPS the mode instead of carrying it over; falling back to
 * the engine's own precedence (H.264 first) is always safe, whereas inheriting
 * MJPEG onto a camera that only does H.264 is not.
 *
 * And an EXPLICIT pick the device does not advertise is REFUSED, while a merely
 * CARRIED one is silently dropped. A refusal answers the operator's own action
 * honestly; applying the same refusal to a value they are not touching would let
 * a device that stopped advertising a mode block every unrelated save.
 */
function resolveInputModeChoice(
	input: StreamingSetConfigInput,
	config: RuntimeConfig,
	sources: readonly StreamSource[],
): InputModeChoice {
	const sourceId = input.source ?? config.source;
	const source =
		sourceId === undefined
			? undefined
			: sources.find(
					(entry) =>
						entry.id ===
						resolveSourceIdentity(
							sourceId,
							sources,
							config.last_seen_devices,
							input.source === undefined
								? configuredSelectionAnchor(sourceId)
								: undefined,
						),
				);

	const carried = staysOnTheSameDevice(input, config, sources)
		? config.input_mode
		: undefined;
	const requested = input.input_mode ?? carried;
	if (requested === undefined) return { ok: true, inputMode: undefined };

	const offered = source?.origin === "capture" ? source.inputModes : undefined;
	// No advertised split is an ABSENCE of truth, not evidence against the pick —
	// the same none-cap policy the device-mode rule follows.
	if (offered === undefined || offered.length === 0) {
		return { ok: true, inputMode: requested };
	}
	if (offered.some((mode) => mode.inputMode === requested)) {
		return { ok: true, inputMode: requested };
	}
	if (input.input_mode !== undefined) {
		return { ok: false, error: INPUT_MODE_UNSUPPORTED_ERROR };
	}
	return { ok: true, inputMode: undefined };
}

/** Whether this save keeps pointing at the SAME physical device as the last one. */
function staysOnTheSameDevice(
	input: StreamingSetConfigInput,
	config: RuntimeConfig,
	sources: readonly StreamSource[],
): boolean {
	if (input.source === undefined) return true;
	const anchor = resolveSelectionAnchor(input.source, sources);
	return anchor !== undefined && anchor === config.source_stable_id;
}

export const setConfigProcedure = authedProcedure
	.input(streamingSetConfigInputSchema)
	.output(streamingSetConfigOutputSchema)
	.handler(async ({ input }) => {
		const config = getConfig();

		// Device-first source selection (T3). Resolve at the PROCEDURE, BEFORE any
		// merge: an unknown source rejects with disk unchanged; a known source folds
		// its derived pipeline into `input` so the override-validation + merge below
		// see it. selected_video_input is recomputed on EVERY source write (persisted
		// further down) — the capture input_id, or cleared for a non-capture source.
		const sourcesSnapshot = getSourcesMessage().sources;

		// A mode belongs to ONE device, so it is resolved BEFORE routing: the mode
		// decides which pipeline the device is opened through, and a pick carried
		// over from different hardware must be dropped rather than applied to a
		// camera that never advertised it.
		const modeChoice = resolveInputModeChoice(input, config, sourcesSnapshot);
		if (!modeChoice.ok) {
			logger.warn("setConfig: the device does not offer the requested mode", {
				module: "streaming",
				source: input.source ?? config.source,
				input_mode: input.input_mode,
			});
			return { success: false, error: modeChoice.error, applied: {} };
		}
		const effectiveInputMode = modeChoice.inputMode;

		let sourceRouting:
			| Extract<ResolveSourceRoutingResult, { ok: true }>
			| undefined;
		if (input.source !== undefined) {
			const routed = resolveSourceRouting(
				input.source,
				sourcesSnapshot,
				config.last_seen_devices,
				undefined,
				effectiveInputMode,
			);
			if (!routed.ok) {
				return { success: false, error: routed.error, applied: {} };
			}
			sourceRouting = routed;
			input.pipeline = routed.pipeline;
		} else if (
			effectiveInputMode !== config.input_mode &&
			config.source !== undefined
		) {
			// A mode-only save still moves the pipeline — a dual-format camera is
			// `libuvch264` in H.264 mode and `usb_mjpeg` in MJPEG mode — so the
			// PERSISTED selection is re-routed under the new mode. It resolves
			// through the persisted anchor, exactly as the start path does, and
			// deliberately does NOT set `sourceRouting`: nothing about the operator's
			// source SELECTION changed, so `config.source` must not be rewritten.
			const routed = resolveSourceRouting(
				config.source,
				sourcesSnapshot,
				config.last_seen_devices,
				configuredSelectionAnchor(config.source),
				effectiveInputMode,
			);
			if (!routed.ok) {
				return { success: false, error: routed.error, applied: {} };
			}
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

		// Three orderings here are load-bearing (ADR-0008 §10 / todo 11a). It runs
		// BEFORE the first config mutation, so a refusal leaves disk byte-identical
		// — the class being killed is a PERSISTED 1080p60 on a 30-fps H.264 ladder,
		// re-sent on every start. Both axes resolve input-then-persisted, because a
		// half-save is still a full pairing against the hardware. And the source is
		// the one being SAVED: checking the persisted one waves through exactly the
		// ladder switch that makes the combo illegal.
		if (
			input.resolution !== undefined ||
			input.framerate !== undefined ||
			effectiveInputMode !== config.input_mode
		) {
			const verdict = verifySaveDeviceMode(
				{
					sourceId: input.source ?? config.source,
					resolution: input.resolution ?? config.resolution,
					framerate: input.framerate ?? config.framerate,
					// A mode SWITCH re-validates the persisted axes against the ladder
					// they will now be negotiated on: the very point of the per-media_type
					// split is that 1080p60 on H.264 says nothing about MJPEG.
					inputMode: effectiveInputMode,
				},
				{ sources: sourcesSnapshot, lastSeenDevices: config.last_seen_devices },
			);
			if (!verdict.supported) {
				logger.warn("setConfig: device cannot deliver the requested mode", {
					module: "streaming",
					source: input.source ?? config.source,
					resolution: input.resolution ?? config.resolution,
					framerate: input.framerate ?? config.framerate,
					reason: verdict.reason,
				});
				return {
					success: false,
					error: DEVICE_MODE_UNSUPPORTED_ERROR,
					applied: {},
				};
			}
		}

		// Apply-now splits the save in two: the restart-requiring fields are held
		// back (staged, never written) so `config.json` keeps describing what the
		// engine is ACTUALLY running until the transaction says `applied`. Every
		// other field in the same save persists immediately, exactly as before.
		const staged = stageApplyNowFields(input, config, sourceRouting);
		if (staged !== undefined) sourceRouting = undefined;

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
		if (input.video_passthrough !== undefined)
			config.video_passthrough = input.video_passthrough;
		// Never staged behind `apply_now`: the engine fixes the preview encoder when
		// it builds the main graph, so this can only ever take effect at the next
		// start. Persisting immediately is what lets the replay fence read it.
		if (input.previewEncode !== undefined)
			config.previewEncode = input.previewEncode;
		if (input.source_preference !== undefined)
			config.source_preference = input.source_preference;
		if (input.selected_video_input !== undefined)
			config.selected_video_input = input.selected_video_input;
		// A resolved source overwrites selected_video_input verbatim (undefined
		// clears a stale capture input) and persists the operator's source id.
		if (sourceRouting !== undefined) {
			config.source = input.source;
			config.selected_video_input = sourceRouting.selected_video_input;
			noteSourceSelectionWrite(input.source);
		}
		// Written even when it resolves to `undefined`: that is the CLEAR, and it is
		// what stops a mode chosen for one camera governing the next one.
		config.input_mode = effectiveInputMode;
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
		if (input.previewEncode !== undefined)
			applied.previewEncode = config.previewEncode;
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
		if (input.input_mode !== undefined) {
			applied.input_mode = config.input_mode;
			applied.pipeline = config.pipeline;
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
		// A new audio pick must reach the ALWAYS-IDLE level meter too, or the meter
		// keeps reporting whichever card the engine chose for itself. A VIDEO source
		// change counts: under "Auto" the audio pick is a FUNCTION of the video
		// source, so switching camera → HDMI moves the resolved card with `asrc`
		// untouched. Re-pushing an UNCHANGED pick is free — the bridge dedupes on
		// the (silenced, preference) pair — but skipping a changed one is not:
		// the engine's `set_preferred_device` early-returns on an unchanged value,
		// so nothing later corrects it.
		if (input.asrc !== undefined || input.source !== undefined) {
			syncAudioMeterPreference();
		}

		if (staged === undefined) return { success: true, applied };

		const outcome = await getApplyNowGate().dispatch({
			...(staged.resolution === undefined
				? {}
				: { resolution: staged.resolution }),
			...(staged.framerate === undefined
				? {}
				: { framerate: staged.framerate }),
			...(staged.video_codec === undefined
				? {}
				: { video_codec: staged.video_codec }),
			...(staged.selected_video_input === undefined
				? {}
				: { input_id: staged.selected_video_input }),
			...(staged.pipeline === undefined ? {} : { pipeline: staged.pipeline }),
			...(staged.input_mode === undefined
				? {}
				: { input_mode: staged.input_mode }),
		});

		if (outcome.result !== "applied") {
			// reverted / rollback_failed / busy / rejected all leave the persisted
			// values alone — they are still the ones the engine last ran.
			abandonStagedConfigChange();
			return {
				success: outcome.result === "reverted",
				applied,
				configChange: outcome,
			};
		}

		commitStagedConfigChange();
		const persisted = getConfig();
		broadcastMsg("config", persisted);
		// Post-clamp echo for the staged half, same rule as the merge above.
		if (staged.resolution !== undefined)
			applied.resolution = persisted.resolution;
		if (staged.framerate !== undefined) applied.framerate = persisted.framerate;
		if (staged.video_codec !== undefined)
			applied.video_codec = persisted.video_codec;
		if (staged.source !== undefined) {
			applied.source = persisted.source;
			applied.pipeline = persisted.pipeline;
			applied.selected_video_input = persisted.selected_video_input;
		}
		return { success: true, applied, configChange: outcome };
	});

/**
 * Persist device-wide source visibility (test-pattern hide) — config-only, no
 * service gate. The SINGLE mutation path for `sources_visibility`: persist via
 * the atomic saveConfig, then rebroadcast BOTH the unified `sources` snapshot (so
 * the Live source list re-renders the marked-but-never-dropped row) and the
 * `config` echo (so the Sources dialog reflects the saved toggle).
 */
export const setSourceVisibilityProcedure = authedProcedure
	.input(setSourceVisibilityInputSchema)
	.output(setSourceVisibilityOutputSchema)
	.handler(({ input }) => {
		const config = getConfig();
		config.sources_visibility = { hide_test_pattern: input.hide_test_pattern };
		saveConfig();
		broadcastMsg("config", config);
		broadcastSources();
		return {
			success: true,
			applied: { hide_test_pattern: input.hide_test_pattern },
		};
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
 * Detach/reattach one mock capture device by input_id (dev-only). Drives the
 * single-device unplug/replug seam so e2e can exercise the lost-row grace state
 * and the shared source_lost start rejection.
 */
export const setMockDeviceAttachedProcedure = authedProcedure
	.input(setMockDeviceAttachedInputSchema)
	.output(setMockDeviceAttachedOutputSchema)
	.handler(({ input }) => {
		if (!shouldUseMocks()) {
			return {
				success: false,
				error: "Mock device attach/detach only available in development mode",
			};
		}
		setMockDeviceAttached(input.input_id, input.attached);
		return { success: true };
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
	noteSourceSelectionWrite(inputId);
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
