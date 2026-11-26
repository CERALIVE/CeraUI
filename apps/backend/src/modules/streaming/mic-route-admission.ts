import {
	AUDIO_SILENCE_INPUT_ID,
	type AudioConfig,
	type CheckMicRoutesParams,
} from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfigFilePath } from "../config.ts";
import {
	captureMicPickerAttachment,
	isPseudoAudioSource,
	resolveAudioMode,
} from "./audio.ts";
import {
	audioInputEngineId,
	effectiveAudioInputs,
	launchAudioPlan,
} from "./audio-inputs.ts";
import { searchPipelines } from "./pipelines.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

export function micRouteKeys(audio: AudioConfig | undefined): string[] {
	if (audio?.inputs !== undefined)
		return audio.inputs
			.map((input) => input.device ?? input.input_id)
			.filter((id) => id !== "embedded" && id !== AUDIO_SILENCE_INPUT_ID);
	return audio?.device === undefined || audio.mode === "none"
		? []
		: [audio.device];
}

export function hasOrderedMicProofs(proofs: readonly string[], count: number) {
	return proofs.length === count && new Set(proofs).size === count;
}

export function networkAudioSource(pipeline: string | undefined): boolean {
	return (
		pipeline !== undefined &&
		searchPipelines(pipeline)?.audio_kind === "embedded"
	);
}

function observe(config: RuntimeConfig, audio: AudioConfig) {
	if (shouldUseMocks()) return Promise.resolve(undefined);
	const request = {
		audio: { ...audio, backend: config.audio_backend },
		network: networkAudioSource(config.pipeline),
		operation: { kind: "admit" },
	} satisfies CheckMicRoutesParams;
	return getStreamingBackend().admitMicRoutes(request);
}

type Admission = Promise<string | undefined>;
const savedChoices = new WeakMap<
	RuntimeConfig,
	{ readonly path: string; readonly proofs: Map<string, Admission> }
>();

export function captureMicChoices(ids: readonly string[]) {
	return [...new Set(ids)]
		.filter((id) => id !== AUDIO_SOURCE_AUTO && !isPseudoAudioSource(id))
		.map((id) => ({ id, current: captureMicPickerAttachment(id) }));
}

/** The proof is usable only if the listed attachment spans engine observation. */
export function noteMicChoices(
	config: RuntimeConfig,
	selected: ReturnType<typeof captureMicChoices>,
): Promise<boolean> | undefined {
	if (shouldUseMocks()) return undefined;
	const choicesToObserve = selected.flatMap(({ id, current }) => {
		const device = config.audio_inputs?.some((input) => input.id === id)
			? audioInputEngineId(id, config)
			: resolveAudioMode(id, false).device;
		return device === undefined ||
			device === "embedded" ||
			device === AUDIO_SILENCE_INPUT_ID
			? []
			: [{ id, device, current }];
	});
	const [first, second] = choicesToObserve;
	if (first === undefined) return undefined;
	const path = getConfigFilePath();
	let choices = savedChoices.get(config);
	if (choices?.path !== path) {
		choices = { path, proofs: new Map() };
		savedChoices.set(config, choices);
	}
	const observed = (async () => {
		if (!choicesToObserve.every(({ current }) => current())) return undefined;
		const proofs = await observe(
			config,
			second === undefined
				? { mode: "device", device: first.device }
				: {
						mode: "default",
						inputs: choicesToObserve.map(({ device }) => ({
							input_id: device,
							tracks: [1],
						})),
					},
		);
		return proofs !== undefined &&
			hasOrderedMicProofs(proofs, choicesToObserve.length) &&
			choicesToObserve.every(({ current }) => current())
			? proofs
			: undefined;
	})();
	for (const [index, { id }] of choicesToObserve.entries())
		choices.proofs.set(
			id,
			observed.then((proofs) => proofs?.[index]),
		);
	return observed.then((proofs) => proofs !== undefined);
}

/** Freeze the used legs at Start acceptance (or the concrete Auto decision). */
export function freezeMicChoices(
	config: RuntimeConfig,
	saved: RuntimeConfig,
	prior: ReadonlyMap<string, Admission> = new Map(),
	audioOff?: boolean,
): ReadonlyMap<string, Admission> {
	const plan = launchAudioPlan(config, { audioOff });
	const keys = micRouteKeys(plan);
	const accepted = new Map(prior);
	if (plan === undefined || keys.length === 0) return accepted;
	const ids =
		plan.inputs === undefined
			? [config.asrc]
			: keys.map(
					(key) =>
						effectiveAudioInputs(config)?.find(
							({ id }) => audioInputEngineId(id, config) === key,
						)?.id,
				);
	const choices = savedChoices.get(saved);
	let pending: ReturnType<typeof observe> | undefined;
	for (const [index, id] of ids.entries()) {
		if (id === undefined || accepted.has(id)) continue;
		const choice =
			choices?.path === getConfigFilePath()
				? choices.proofs.get(id)
				: undefined;
		if (choice !== undefined) {
			accepted.set(id, choice);
		} else {
			pending ??= observe(config, plan);
			accepted.set(
				id,
				pending.then((proofs) => proofs?.[index]),
			);
		}
	}
	return accepted;
}
