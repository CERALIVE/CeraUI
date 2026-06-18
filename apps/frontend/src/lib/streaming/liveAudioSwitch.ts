/**
 * Live audio-switch guard (Task 10) — pure, rune-free helpers that make it
 * impossible for the UI to dispatch a live `switchInput` for an `audio:*` source
 * while the engine has not advertised the capability.
 *
 * The sole gate is `isAudioLiveSwitchEnabled(getCapabilities())` (G2) — there is
 * no version-string check anywhere. These helpers exist so the dispatch decision
 * is unit-testable in isolation and shared by every call site that could emit a
 * live input switch.
 */

/** Audio capture sources are registered with an `audio:<id>` input id. */
export const AUDIO_INPUT_PREFIX = "audio:";

/** Whether an input id addresses an audio capture source. */
export function isAudioInputId(inputId: string): boolean {
	return inputId.startsWith(AUDIO_INPUT_PREFIX);
}

/**
 * Decide whether a live `switchInput` may be dispatched for `inputId`.
 *
 * A non-audio source is always switchable. An `audio:*` source is switchable
 * only when the engine advertises live audio switching
 * (`audioLiveSwitchEnabled === true`). When it does not, this returns `false`
 * and the caller must NOT call `rpc.streaming.switchInput`.
 */
export function canLiveSwitchInput(
	inputId: string,
	audioLiveSwitchEnabled: boolean,
): boolean {
	if (isAudioInputId(inputId)) return audioLiveSwitchEnabled;
	return true;
}
