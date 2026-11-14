import type { AudioInputSetting } from "@ceraui/rpc/schemas";

export function defaultAudioInput(id: string): AudioInputSetting {
	return { id, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 };
}

/**
 * The mix Start sends: the saved entries with the main input in them, the
 * backend's `effectiveAudioInputs`. A main input outside the saved mix joins
 * first on Track 1; in a full mix it takes the place and the tracks of
 * `previous`, the main input it replaces, or of the first entry (the UI saves
 * the main input first) when that one is not in the mix.
 */
export function effectiveAudioInputs(
	saved: readonly AudioInputSetting[] | null | undefined,
	primary: string | undefined,
	maxInputs: number,
	previous?: string,
): AudioInputSetting[] | undefined {
	if (!saved?.length) return undefined;
	if (primary === undefined || saved.some((input) => input.id === primary))
		return [...saved];
	if (saved.length < maxInputs) return [defaultAudioInput(primary), ...saved];
	const replaced = saved.find((input) => input.id === previous) ?? saved[0];
	return [
		{ ...defaultAudioInput(primary), tracks: [...(replaced?.tracks ?? [1])] },
		...saved.filter((input) => input !== replaced),
	];
}

/**
 * The one `setConfig` a pick in the audio picker makes. A device picked outside
 * a saved mix carries the mix it implies in the same write, so the pick and the
 * mix Start sends never disagree, and a full mix replaces the main input the
 * pick replaces (`previous`), not whichever entry happens to be first.
 */
export function audioPickSave(
	asrc: string,
	options: {
		saved: readonly AudioInputSetting[] | null | undefined;
		maxInputs: number | undefined;
		previous: string | undefined;
		mixInput: boolean;
	},
): { asrc: string; audio_inputs?: AudioInputSetting[] } {
	const { saved, maxInputs, previous, mixInput } = options;
	if (
		!mixInput ||
		maxInputs === undefined ||
		!saved?.length ||
		saved.some((input) => input.id === asrc)
	)
		return { asrc };
	const audio_inputs = effectiveAudioInputs(saved, asrc, maxInputs, previous);
	return audio_inputs ? { asrc, audio_inputs } : { asrc };
}
