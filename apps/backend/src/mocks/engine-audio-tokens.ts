// Every audio refusal token cerastream returns, at origin/main 2ad2349e:
// crates/cerastream/src/engine/audio_mix.rs (validate, start),
// crates/cerastream/src/engine/audio_mix/live.rs (set-audio-mix) and
// crates/cerastream/src/engine.rs (switch-audio while mixing).
// Side-effect free, so e2e helpers import it beside the mock engine.
export const ENGINE_AUDIO_TOKENS = [
	"audio-mix-empty",
	"audio-mix-too-many-inputs",
	"audio-mix-with-device",
	"audio-mix-with-mode-none",
	"audio-mix-duplicate-input",
	"audio-mix-embedded-without-network-source",
	"audio-tracks-invalid",
	"audio-gain-range",
	"audio-delay-range",
	"audio-tracks-gap",
	"audio-mix-unsupported",
	"audio-mix-inactive",
	"audio-mix-active",
] as const;
export type EngineAudioToken = (typeof ENGINE_AUDIO_TOKENS)[number];

/** How cerastream refuses an audio-mix change with `token`: its params-invalid envelope. */
export function engineAudioMixRefusal(token: EngineAudioToken): {
	code: number;
	message: string;
	dataCode: string;
} {
	return {
		code: -32602,
		message: `invalid params: ${token}: invalid audio mix configuration`,
		dataCode: "cerastream.params.invalid",
	};
}
