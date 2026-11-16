import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	CerastreamRpcError,
	RPC_ERROR_NUMERIC,
	type StartParams,
} from "@ceralive/cerastream";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	setMockAudioMix,
	startMockStreaming,
	switchMockAudio,
} from "../mocks/providers/streaming.ts";

const mode = process.env.MOCK_MODE;
const base: StartParams = {
	pipeline: "test",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 2000 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "adaptive" },
};
beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});
afterEach(() => {
	stopMockService();
	if (mode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = mode;
});

function refusal(action: () => unknown) {
	try {
		action();
	} catch (error) {
		if (!(error instanceof CerastreamRpcError)) throw error;
		return {
			code: error.code,
			message: error.message,
			dataCode: error.dataCode,
			data: error.data,
			captureCauses: error.captureCauses(),
		};
	}
	throw new Error("Expected a native audio refusal");
}

test.each([
	{
		name: "start",
		run: () => startMockStreaming({ ...base, audio: { inputs: [] } }),
		token: "audio-mix-empty",
	},
	{
		name: "live",
		run: () => setMockAudioMix({ inputs: [] }),
		token: "audio-mix-inactive",
	},
])("mock %s preserves the native mix validation envelope", ({ run, token }) => {
	expect(refusal(run)).toEqual({
		code: -32602,
		message: `invalid params: ${token}: invalid audio mix configuration`,
		dataCode: "cerastream.params.invalid",
		data: { code: "cerastream.params.invalid" },
		captureCauses: [],
	});
});

test.each(["start", "live"])(
	"mock %s preserves the native unknown audio input envelope",
	(path) => {
		if (path === "live")
			startMockStreaming({
				...base,
				audio: { inputs: [{ input_id: "audio_rode_ai_micro", tracks: [1] }] },
			});
		expect(
			refusal(() =>
				path === "start"
					? startMockStreaming({
							...base,
							audio: { inputs: [{ input_id: "missing", tracks: [1] }] },
						})
					: setMockAudioMix({ inputs: [{ input_id: "missing" }] }),
			),
		).toEqual({
			code: RPC_ERROR_NUMERIC["cerastream.audio.device_not_found"],
			message: "audio device not found: missing",
			dataCode: "cerastream.audio.device_not_found",
			data: { code: "cerastream.audio.device_not_found" },
			captureCauses: [],
		});
	},
);

test("mock source switch preserves the native active mix refusal", () => {
	startMockStreaming({
		...base,
		audio: { inputs: [{ input_id: "audio_rode_ai_micro", tracks: [1] }] },
	});
	expect(refusal(() => switchMockAudio("audio_rode_ai_micro"))).toEqual({
		code: -32602,
		message:
			"invalid params: audio-mix-active: switch-audio is unavailable while mixing inputs",
		dataCode: "cerastream.params.invalid",
		data: { code: "cerastream.params.invalid" },
		captureCauses: [],
	});
});
