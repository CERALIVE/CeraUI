import { getMockState, shouldUseMocks } from "../../mocks/mock-service.ts";
import { deriveAudioSources } from "./audio.ts";
import { audioInputEngineId } from "./audio-inputs.ts";
import { cerastreamBackend } from "./cerastream-backend.ts";
import { getIsStreaming } from "./streaming.ts";

export function getAudioMixInputs() {
	if (!shouldUseMocks()) return cerastreamBackend.getAudioMixInputs();
	const start = getMockState().engineStart;
	if (!getIsStreaming() || !start?.audio?.inputs) return undefined;
	return start.audio.inputs.map((input) => ({
		...input,
		id:
			input.input_id === "embedded"
				? start.pipeline
				: (deriveAudioSources().find(
						(source) =>
							source.kind === "device" &&
							audioInputEngineId(source.id, { pipeline: start.pipeline }) ===
								input.input_id,
					)?.id ?? input.input_id),
	}));
}

export function getAudioMixActive(): boolean {
	return getIsStreaming() && getAudioMixInputs() !== undefined;
}

export function audioMixSourceId(inputId: string): string {
	return (
		getAudioMixInputs()?.find((input) => input.input_id === inputId)?.id ??
		inputId
	);
}
