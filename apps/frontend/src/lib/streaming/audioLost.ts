import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";

const PSEUDO_AUDIO_SOURCES = new Set(["No audio", "Pipeline default"]);

/**
 * Whether the operator's selected audio device is a real device that has
 * vanished from the available list. Mirrors the backend `isSelectedAudioLost`:
 * pseudo sources (No audio / Pipeline default) and the Auto sentinel are never
 * "lost". A missing selection or missing list is never a loss.
 */
export function isSelectedAudioLost(
	asrc: string | undefined,
	available: readonly string[] | undefined,
): boolean {
	if (!asrc || available === undefined) return false;
	if (asrc === AUDIO_SOURCE_AUTO || PSEUDO_AUDIO_SOURCES.has(asrc))
		return false;
	if (available.length === 0) return false;
	return !available.includes(asrc);
}
