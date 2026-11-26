import { audioMixWithPrimary } from "@ceraui/rpc/schemas";
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
import { audioInputEngineId, effectiveAudioInputs } from "./audio-inputs.ts";
import { getLastCapabilities } from "./capabilities.ts";

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
	saved: Pick<RuntimeConfig, StartAudioField> = getConfig(),
	recordedEvidence?: ReadonlyMap<string, AudioIdentityEvidence>,
): StartAudio {
	const savedAsrc = saved.asrc;
	const saves = { ...audioSaves };
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
			const { asrc, audio_inputs, acodec, delay } = startAudio.config;
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
export function restoredStartAudio({
	audio_inputs,
	audio_physical_ids,
	audio_unverified_ids,
	audio_silenced,
	...recorded
}: ArmedStreamConfig): StartAudio {
	return acceptStartAudio(
		{},
		{
			...(audio_inputs === undefined
				? getConfig()
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
	if (audioOff || audioEvidence.size === 0)
		return {
			ok: true,
			asrc,
			audio_inputs,
			audio_physical_ids: undefined,
			audio_unverified_ids: undefined,
		} as const;

	const roster = liveAudioIdentityEvidence();
	const mix = audio_inputs?.length
		? getLastCapabilities()?.audio_mix
		: undefined;
	const pinned = new Map<string, string>();
	const unverified = new Set<string>();
	const resolve = (id: string) => {
		const evidence = audioEvidence.get(id);
		if (evidence === undefined) return id;
		const address = audioAddressForEvidence(id, evidence, roster);
		if (address !== undefined) {
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
		const effective =
			asrc !== undefined && audioEvidence.has(asrc)
				? audioMixWithPrimary(audio_inputs, asrc, mix.max_inputs)
				: effectiveAudioInputs(config);
		const projected = { ...config, asrc: primary };
		const engineIds = new Set<string>();
		inputs = [];
		for (const input of effective ?? []) {
			const id = resolve(input.id);
			if (id === undefined) return { ok: false } as const;
			const engineId = audioInputEngineId(id, projected);
			if (engineIds.has(engineId)) return { ok: false } as const;
			engineIds.add(engineId);
			inputs.push({ ...input, id });
		}
	}
	return {
		ok: true,
		asrc: primary,
		audio_inputs: inputs,
		audio_physical_ids: pinned.size ? Object.fromEntries(pinned) : undefined,
		audio_unverified_ids: unverified.size ? [...unverified] : undefined,
	} as const;
}
