import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { getConfig } from "../config.ts";
import type { ArmedStreamConfig } from "./armed-stream-marker.ts";
import {
	type AudioIdentityEvidence,
	audioAddressForEvidence,
	audioIdentitySuccessor,
	liveAudioIdentityEvidence,
	NO_AUDIO_ID,
	refreshBluetoothAudioDevices,
} from "./audio.ts";
import {
	audioInputEngineId,
	effectiveAudioInputs,
	projectLaunchAudioInputs,
} from "./audio-inputs.ts";
import { getLastCapabilities } from "./capabilities.ts";
import {
	captureSavedMicProofs,
	freezeMicChoices,
} from "./mic-route-admission.ts";

// The audio fields a Start request may save.
const audioSaves = { asrc: 0, audio_inputs: 0, acodec: 0, delay: 0 };
type SavedAudioField = keyof typeof audioSaves;
type StartAudioField = SavedAudioField | "audio_backend";

/** The operator saved an audio choice; repeating the saved value counts too. */
export function noteAudioSaved(field: SavedAudioField): void {
	audioSaves[field] += 1;
}

type StartAudioConfig = {
	readonly [Field in StartAudioField]: RuntimeConfig[Field];
};
interface StartAudioRequest {
	readonly pipeline?: string | undefined;
	readonly source?: string | undefined;
	readonly asrc?: string | undefined;
	readonly audio_inputs?: RuntimeConfig["audio_inputs"] | null;
	readonly acodec?: string | undefined;
	readonly delay?: number | undefined;
}

export interface StartAudio {
	/**
	 * The audio configuration the Start was pressed with, for every launch of it. A
	 * known microphone keeps its accepted key until the launch resolves its identity.
	 */
	readonly config: StartAudioConfig;
	readonly audioEvidence: ReadonlyMap<string, AudioIdentityEvidence>;
	readonly micChoices: ReturnType<typeof freezeMicChoices>;
	readonly autoMicChoices: (
		config: RuntimeConfig,
		audioOff: boolean,
	) => ReturnType<typeof freezeMicChoices>;
	/** Proofs accepted by the engine for this launch, not just observed at press. */
	readonly verifiedMicChoices: Map<string, string>;
	readonly originalMicChoice: (id: string) => string;
	readonly restoration?: {
		readonly proofs: ArmedStreamConfig["mic_route_proofs"];
		readonly legacyAddressOnly: boolean;
	};
	/** The saved pick at the press: it needs no device to be present yet. */
	readonly savedAsrc: string | undefined;
	/**
	 * What the request itself asks to save: nothing that has been saved since the
	 * press, and no pick that only restates the saved one.
	 */
	readonly unsaved: () => Partial<StartAudioConfig>;
	/** Keeps the pressed backend's microphones listed until `start` is done. */
	readonly whileInFlight: <T>(start: Promise<T>) => Promise<T>;
}

const inFlight = new Set<StartAudio>();

/** The backend the Bluetooth microphones are listed for: the oldest Start's, if any. */
export function audioBackendInUse(): RuntimeConfig["audio_backend"] {
	const [starting] = inFlight;
	return (starting?.config ?? getConfig()).audio_backend;
}

/**
 * Freeze a Start's audio where the Start is requested, before anything it waits
 * for. A Start uses the audio configuration carried by the Start request; saves
 * made while it is in flight apply to the next Start only.
 */
export function acceptStartAudio(
	request: StartAudioRequest = {},
	saved: RuntimeConfig = getConfig(),
	recordedEvidence?: ReadonlyMap<string, AudioIdentityEvidence>,
	restoration?: StartAudio["restoration"],
): StartAudio {
	const savedAsrc = saved.asrc;
	const saves = { ...audioSaves };
	const savedProofs = captureSavedMicProofs(saved);
	const pressed: StartAudioConfig = structuredClone({
		asrc: request.asrc ?? savedAsrc,
		audio_inputs:
			request.audio_inputs === undefined
				? saved.audio_inputs
				: (request.audio_inputs ?? undefined),
		// `validateConfig` refuses a codec outside the enum.
		acodec: (request.acodec ?? saved.acodec) as RuntimeConfig["acodec"],
		delay: request.delay ?? saved.delay,
		audio_backend: saved.audio_backend,
	});
	const audioEvidence = new Map<string, AudioIdentityEvidence>();
	const roster = recordedEvidence ?? liveAudioIdentityEvidence();
	for (const id of [
		pressed.asrc,
		...(pressed.audio_inputs?.map(({ id }) => id) ?? []),
	]) {
		if (id === undefined) continue;
		const evidence = roster.get(id);
		if (evidence !== undefined) audioEvidence.set(id, evidence);
	}
	const legacySuccessor = (id: string) =>
		audioEvidence.has(id) ? undefined : audioIdentitySuccessor(id);
	const startAudio: StartAudio = {
		audioEvidence,
		verifiedMicChoices: new Map(),
		originalMicChoice: (id) =>
			startAudio.micChoices.has(id)
				? id
				: ([...startAudio.micChoices.keys()].find(
						(key) => legacySuccessor(key) === id,
					) ?? id),
		...(restoration === undefined ? {} : { restoration }),
		autoMicChoices: (config, audioOff) =>
			freezeMicChoices(config, savedProofs, startAudio.micChoices, audioOff),
		micChoices:
			restoration === undefined
				? freezeMicChoices(
						{
							...saved,
							...request,
							...pressed,
							pipeline: request.pipeline ?? saved.pipeline,
							source: request.source ?? saved.source,
							asrc:
								pressed.asrc === AUDIO_SOURCE_AUTO ? undefined : pressed.asrc,
						},
						savedProofs,
					)
				: new Map(),
		get config() {
			const { asrc, audio_inputs } = pressed;
			return {
				...pressed,
				asrc: (asrc && legacySuccessor(asrc)) || asrc,
				audio_inputs: audio_inputs?.map((input) => {
					const id = legacySuccessor(input.id);
					return id === undefined || audio_inputs.some((own) => own.id === id)
						? input
						: { ...input, id };
				}),
			};
		},
		savedAsrc,
		unsaved: () => {
			if (saved !== getConfig()) return {};
			const { asrc, audio_inputs, acodec, delay } = startAudio.config;
			// Hardware address migration is not a new operator save.
			const stillNewest = (field: SavedAudioField) =>
				request[field] !== undefined && audioSaves[field] === saves[field];
			return {
				...(stillNewest("asrc") && pressed.asrc !== savedAsrc ? { asrc } : {}),
				...(stillNewest("audio_inputs") ? { audio_inputs } : {}),
				...(stillNewest("acodec") ? { acodec } : {}),
				...(stillNewest("delay") ? { delay } : {}),
			};
		},
		whileInFlight: async (start) => {
			inFlight.add(startAudio);
			try {
				return await start;
			} finally {
				inFlight.delete(startAudio);
				if (getConfig().audio_backend !== pressed.audio_backend)
					await refreshBluetoothAudioDevices();
			}
		},
	};
	return startAudio;
}

/**
 * What a restoration starts with: the audio its marker recorded, whatever is saved
 * now. A marker that records the mix records the whole choice, so what it omits was
 * unset; an older one leaves the mix and the backend to the saved ones.
 */
export function restoredStartAudio(
	{
		audio_inputs,
		audio_physical_ids,
		audio_unverified_ids,
		audio_silenced,
		mic_route_proofs,
		balancer: _balancer,
		failover_rate_policy: _failoverRatePolicy,
		previewEncode: _previewEncode,
		...recorded
	}: ArmedStreamConfig,
	saved: RuntimeConfig,
): StartAudio {
	return acceptStartAudio(
		{},
		{
			...(audio_inputs === undefined
				? saved
				: { audio_inputs: audio_inputs ?? undefined }),
			...recorded,
			...(audio_silenced ? { asrc: NO_AUDIO_ID } : {}),
		},
		// An older marker cannot attest to whoever now occupies its address.
		new Map<string, AudioIdentityEvidence>([
			...Object.entries(audio_physical_ids ?? {}).map(
				([id, stableId]) => [id, { kind: "physical", stableId }] as const,
			),
			...(audio_unverified_ids ?? []).map(
				(id) => [id, { kind: "unavailable" }] as const,
			),
		]),
		{
			proofs: mic_route_proofs,
			legacyAddressOnly:
				mic_route_proofs === undefined &&
				audio_physical_ids === undefined &&
				audio_unverified_ids === undefined,
		},
	);
}

/** Resolve the admitted inputs once more at the engine request, never by old address. */
export function resolvePinnedLaunchAudio(
	config: RuntimeConfig,
	audioEvidence: ReadonlyMap<string, AudioIdentityEvidence>,
	{
		audioOff,
		embedded,
	}: { readonly audioOff: boolean; readonly embedded: boolean },
) {
	const { asrc, audio_inputs } = config;
	if (audioOff)
		return {
			ok: true,
			asrc,
			audio_inputs,
			audio_physical_ids: undefined,
			audio_unverified_ids: undefined,
			originalKeys: new Map<string, string>(),
		} as const;

	const roster = liveAudioIdentityEvidence();
	const mix = audio_inputs?.length
		? getLastCapabilities()?.audio_mix
		: undefined;
	const pinned = new Map<string, string>();
	const unverified = new Set<string>();
	const originalKeys = new Map<string, string>();
	const resolve = (id: string) => {
		const evidence = audioEvidence.get(id);
		if (evidence === undefined) return id;
		const address = audioAddressForEvidence(id, evidence, roster);
		if (address !== undefined) {
			originalKeys.set(address, id);
			if (evidence.kind === "physical") pinned.set(address, evidence.stableId);
			else unverified.add(address);
		}
		return address;
	};
	let primary = asrc;
	if (asrc !== undefined && (!embedded || mix !== undefined)) {
		primary = resolve(asrc);
		if (primary === undefined) return { ok: false } as const;
	}

	let inputs = audio_inputs;
	if (mix !== undefined) {
		// Decide membership before changing any keys: a successor must not
		// absorb a different leg, including an implicitly inserted primary.
		const effective = effectiveAudioInputs(
			config,
			asrc !== undefined && audioEvidence.has(asrc) ? asrc : undefined,
		);
		const projected = { ...config, asrc: primary };
		inputs = projectLaunchAudioInputs(config, effective ?? [], resolve);
		if (inputs === undefined) return { ok: false } as const;
		const engineIds = new Set<string>();
		for (const input of inputs) {
			const engineId = audioInputEngineId(input.id, projected);
			if (engineId === undefined || engineIds.has(engineId))
				return { ok: false } as const;
			engineIds.add(engineId);
		}
	}
	return {
		ok: true,
		asrc: primary,
		audio_inputs: inputs,
		audio_physical_ids: pinned.size ? Object.fromEntries(pinned) : undefined,
		audio_unverified_ids: unverified.size ? [...unverified] : undefined,
		originalKeys,
	} as const;
}
