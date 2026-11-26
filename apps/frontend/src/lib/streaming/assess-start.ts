import {
	type AudioSource,
	audioCodecAllowedForTransport,
	type ConfigMessage,
	type LifecycleState,
	type NetworkIngest,
} from "@ceraui/rpc/schemas";
import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import { isSelectedAudioLost } from "./audioLost";
import { reconcileStartSource } from "./effective-source";
import {
	deriveGoLiveGates,
	GATE_FIX_ORDER,
	type GateFix,
	type GateState,
	type GoLiveGateKey,
	type GoLiveReadinessInput,
} from "./go-live-readiness";
import { pipelineAvailability } from "./pipelineAvailability";
import { pipelinesFromSources } from "./sources-view-model";
import {
	type AudioOverride,
	buildStartConfig,
	withStartAudio,
} from "./startStreaming";

type Input = Omit<GoLiveReadinessInput, "gatewayStatus" | "audio"> & {
	audioOverride: AudioOverride;
	audioSources: AudioSource[] | undefined;
	audioIds: string[] | undefined;
	networkIngest: NetworkIngest | null | undefined;
	lifecycle: LifecycleState | undefined;
	optimism: StreamingOptimismState;
	streaming: boolean;
	outcomeUnknown: boolean;
	updateRefused?: boolean;
};

export interface StartBlocker {
	readonly id: GoLiveGateKey | "update";
	readonly reasonKey: string;
	readonly fix: GateFix;
}

type StartDecision =
	| { state: "ready"; config: ConfigMessage }
	| { state: "blocked"; blockers: readonly StartBlocker[] }
	| { state: "checking" | "starting" | "stopping" | "unconfirmed" | "live" };

function audioGate(
	input: Input,
	config: ConfigMessage,
	supportsAudio: boolean,
	embedded: boolean,
): GateState {
	if (
		config.acodec !== undefined &&
		!audioCodecAllowedForTransport(
			config.acodec,
			config.relay_protocol ?? "srtla",
		)
	) {
		return {
			state: "blocked",
			reasonKey: "live.startFailed.audio_codec_unsupported_transport",
			fix: "openAudio",
		};
	}
	if (!supportsAudio || embedded) return { state: "ok" };
	const selected = input.audioSources?.find(({ id }) => id === config.asrc);
	if (
		(selected?.kind === "device" &&
			selected.unavailable_reason !== undefined) ||
		(!selected && isSelectedAudioLost(config.asrc, input.audioIds))
	) {
		// A current typed roster can distinguish unplugged from listed but unusable.
		const savedMix = config.audio_inputs;
		if (
			selected === undefined &&
			input.audioSources !== undefined &&
			config.asrc === input.config?.asrc &&
			(savedMix === undefined ||
				(savedMix.length === 1 && savedMix[0]?.id === config.asrc))
		)
			return { state: "ok" };
		return {
			state: "blocked",
			reasonKey: "live.inputPicker.audioSourceLost",
			fix: "chooseAudioSource",
		};
	}
	return { state: "ok" };
}

/** Derive the card rows, checklist and dispatchable payload from the same evidence. */
export function assessStart(input: Input) {
	const {
		effective,
		entry,
		config: base,
	} = reconcileStartSource(input.config, input.sources);
	const pipelines = pipelinesFromSources(input.sources);
	const pipeline = base?.pipeline ? pipelines?.[base.pipeline] : undefined;
	const result = buildStartConfig(base, input.audioOverride, pipelines);
	const gatewayObserved =
		!pipeline?.requires_gateway || input.networkIngest !== undefined;
	const gates = deriveGoLiveGates(
		{
			...input,
			config: base,
			gatewayStatus: gatewayObserved
				? pipelineAvailability(pipeline, input.networkIngest)
				: undefined,
			// Even if another gate blocks assembly, an observed audio incompatibility
			// still belongs in the list; the pending override is the value Start uses.
			...(base &&
				pipeline && {
					audio: audioGate(
						input,
						result.ok
							? result.config
							: withStartAudio(base, input.audioOverride),
						pipeline.supportsAudio,
						pipeline.audio_kind === "embedded" &&
							input.caps?.network_embedded_audio === true,
					),
				}),
		},
		{
			entry,
			rejectedPipeline:
				!result.ok &&
				(result.error === "missingPipeline" ||
					result.error === "unknownPipeline"),
		},
	);
	const blockers: StartBlocker[] = [];
	for (const id of GATE_FIX_ORDER) {
		const gate = gates[id];
		if (gate.state === "blocked")
			blockers.push({ id, reasonKey: gate.reasonKey, fix: gate.fix });
	}
	if (input.updateRefused)
		blockers.push({
			id: "update",
			reasonKey: "live.updateInProgress.title",
			fix: "none",
		});

	let decision: StartDecision;
	if (
		input.streaming ||
		input.lifecycle === "streaming" ||
		input.lifecycle === "reconfiguring"
	) {
		decision = { state: "live" };
	} else if (
		input.outcomeUnknown ||
		input.lifecycle === "reconciling" ||
		input.lifecycle === "stop_failed"
	) {
		decision = { state: "unconfirmed" };
	} else if (input.optimism === "stopping" || input.lifecycle === "stopping") {
		decision = { state: "stopping" };
	} else if (input.optimism === "starting" || input.lifecycle === "starting") {
		decision = { state: "starting" };
	} else if (blockers.length > 0) {
		decision = { state: "blocked", blockers };
	} else if (
		!input.isConnected ||
		input.lifecycle !== "idle" ||
		!result.ok ||
		Object.values(gates).some((gate) => gate.state === "unknown") ||
		input.caps?.engineStarting === true
	) {
		decision = { state: "checking" };
	} else {
		decision = { state: "ready", config: result.config };
	}
	return { gates, decision, ...effective };
}

export type StartAssessment = ReturnType<typeof assessStart>;
