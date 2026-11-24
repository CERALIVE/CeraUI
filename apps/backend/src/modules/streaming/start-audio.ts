import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { getConfig } from "../config.ts";
import {
	audioIdentitySuccessor,
	refreshBluetoothAudioDevices,
} from "./audio.ts";

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
	 * microphone that re-enumerated since is named by the id it has now.
	 */
	readonly config: StartAudioConfig;
	/** The saved pick at the press: it needs no device to be present yet. */
	readonly savedAsrc: string | undefined;
	/**
	 * What the request itself asks to save, once: nothing that has been saved since
	 * the press, and no pick that only restates the saved one.
	 */
	readonly takeUnsaved: () => Partial<StartAudioConfig>;
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
export function acceptStartAudio(request: StartAudioRequest = {}): StartAudio {
	const saved = getConfig();
	const savedAsrc = saved.asrc;
	const saves = { ...audioSaves };
	const pressed: StartAudioConfig = structuredClone({
		asrc: request.asrc ?? savedAsrc,
		audio_inputs: request.audio_inputs ?? saved.audio_inputs,
		// `validateConfig` refuses a codec outside the enum.
		acodec: (request.acodec ?? saved.acodec) as RuntimeConfig["acodec"],
		delay: request.delay ?? saved.delay,
		audio_backend: saved.audio_backend,
	});
	let taken = false;
	const startAudio: StartAudio = {
		get config() {
			const { asrc } = pressed;
			return {
				...pressed,
				asrc: (asrc && audioIdentitySuccessor(asrc)) || asrc,
			};
		},
		savedAsrc,
		takeUnsaved: () => {
			if (taken) return {};
			taken = true;
			const { asrc, audio_inputs, acodec, delay } = startAudio.config;
			const unsaved = (field: SavedAudioField) =>
				request[field] != null && audioSaves[field] === saves[field];
			return {
				...(unsaved("asrc") && pressed.asrc !== savedAsrc ? { asrc } : {}),
				...(unsaved("audio_inputs") ? { audio_inputs } : {}),
				...(unsaved("acodec") ? { acodec } : {}),
				...(unsaved("delay") ? { delay } : {}),
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
