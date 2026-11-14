import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	type AudioConfig,
	CerastreamRpcError,
	type CompositionConfig,
	type SetAudioMixParams,
	type StartParams,
} from "@ceralive/cerastream";
import {
	getMockState,
	initMockService,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	changeMockComposition,
	setMockAudioMix,
	startMockStreaming,
} from "../mocks/providers/streaming.ts";

const savedMode = process.env.MOCK_MODE;
const first = "audio_rode_ai_micro";
const base: StartParams = {
	pipeline: "test",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 2000 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "adaptive" },
};
const input = (input_id = first, tracks = [1]) => ({ input_id, tracks });
const rectangle = { x: 0, y: 0, width: 0.5, height: 0.5 };
const custom: CompositionConfig = {
	secondary_input_id: "secondary",
	layout: "custom",
	rect: rectangle,
};
const preset: CompositionConfig = {
	secondary_input_id: "secondary",
	layout: "pip-top-right",
};
const compositionFailures: Array<{
	name: string;
	config: CompositionConfig;
	message?: string;
}> = [
	{
		name: "missing rectangle",
		config: { ...custom, rect: undefined },
		message: "composition-rect-missing: custom layout requires rect",
	},
	{
		name: "out-of-frame rectangle",
		config: { ...custom, rect: { ...rectangle, width: 2 } },
		message:
			"composition-rect-range: rect must fit the frame with sides at least 0.125",
	},
	{
		name: "unexpected rectangle",
		config: { ...preset, rect: rectangle },
		message: "composition-rect-unexpected: preset layouts do not accept rect",
	},
	{ name: "unavailable custom compositor", config: custom },
	{ name: "unavailable preset compositor", config: preset },
	{
		name: "unavailable compositor with invalid secondary and alpha",
		config: { ...preset, secondary_input_id: "", alpha: -1 },
	},
];
const audioFailures = [
	{ name: "empty inputs", audio: { inputs: [] }, token: "audio-mix-empty" },
	{
		name: "too many inputs",
		audio: {
			inputs: Array.from({ length: 5 }, (_, i) => input(`missing-${i}`)),
		},
		token: "audio-mix-too-many-inputs",
	},
	{
		name: "device conflict",
		audio: { inputs: [input()], device: first },
		token: "audio-mix-with-device",
	},
	{
		name: "mode none conflict",
		audio: { inputs: [input()], mode: "none" },
		token: "audio-mix-with-mode-none",
	},
	{
		name: "duplicate input",
		audio: { inputs: [input(), input()] },
		token: "audio-mix-duplicate-input",
	},
	{
		name: "embedded without network",
		audio: { inputs: [input("embedded")] },
		token: "audio-mix-embedded-without-network-source",
	},
	{
		name: "invalid tracks",
		audio: { inputs: [input(first, [0])] },
		token: "audio-tracks-invalid",
	},
	{
		name: "invalid gain",
		audio: { inputs: [{ ...input(), gain_db: 13 }] },
		token: "audio-gain-range",
	},
	{
		name: "invalid delay",
		audio: { inputs: [{ ...input(), delay_ms: 2001 }] },
		token: "audio-delay-range",
	},
	{
		name: "track gap",
		audio: { inputs: [input(first, [2])] },
		token: "audio-tracks-gap",
	},
] satisfies Array<{ name: string; audio: AudioConfig; token: string }>;

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("multi-modem-wifi");
});
afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
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
	throw new Error("Expected a native refusal");
}
const invalidMix = (token: string) => ({
	code: -32602,
	message: `invalid params: ${token}: invalid audio mix configuration`,
	dataCode: "cerastream.params.invalid",
	data: { code: "cerastream.params.invalid" },
	captureCauses: [],
});
const unknownInput = {
	code: -32006,
	message: "audio device not found: missing",
	dataCode: "cerastream.audio.device_not_found",
	data: { code: "cerastream.audio.device_not_found" },
	captureCauses: [],
};
const unavailableComposition: ReturnType<typeof refusal> = {
	code: -32602,
	message:
		"invalid params: composition-unsupported: rgacompositor did not pass its READY backend trial",
	dataCode: "cerastream.params.invalid",
	data: {
		code: "cerastream.params.invalid",
		capture_causes: [
			{ device: "composition", cause: "composition-unsupported" },
		],
	},
	captureCauses: [{ device: "composition", cause: "composition-unsupported" }],
};

for (const row of [
	{
		name: "input count before explicit device",
		audio: {
			inputs: Array.from({ length: 5 }, (_, i) => input(`missing-${i}`)),
			device: first,
		},
		token: "audio-mix-too-many-inputs",
	},
	{
		name: "explicit device before mode none",
		audio: { inputs: [input()], device: first, mode: "none" },
		token: "audio-mix-with-device",
	},
	{
		name: "mode none before duplicate input",
		audio: { inputs: [input(), input()], mode: "none" },
		token: "audio-mix-with-mode-none",
	},
	{
		name: "embedded eligibility before invalid tracks",
		audio: { inputs: [input("embedded", [0])] },
		token: "audio-mix-embedded-without-network-source",
	},
	{
		name: "invalid tracks before gain",
		audio: { inputs: [{ ...input(first, [0]), gain_db: 13 }] },
		token: "audio-tracks-invalid",
	},
	{
		name: "gain before delay",
		audio: { inputs: [{ ...input(), gain_db: 13, delay_ms: 2001 }] },
		token: "audio-gain-range",
	},
] satisfies Array<{ name: string; audio: AudioConfig; token: string }>) {
	test(`Start prioritizes ${row.name} when both fail atomically`, () => {
		const previous = structuredClone(getMockState().engineStart);
		expect(
			refusal(() => startMockStreaming({ ...base, audio: row.audio })),
		).toEqual(invalidMix(row.token));
		expect(getMockState().engineStart).toEqual(previous);
	});
}

for (const audio of audioFailures) {
	for (const composition of compositionFailures) {
		test(`Start prioritizes ${audio.name} before ${composition.name}`, () => {
			expect(
				refusal(() =>
					startMockStreaming({
						...base,
						audio: audio.audio,
						composition: composition.config,
					}),
				),
			).toEqual(invalidMix(audio.token));
			expect(getMockState().engineStart).toBeNull();
		});
	}
	if (audio.audio.inputs.length > 0) {
		test(`Start prioritizes ${audio.name} before unknown audio identity`, () => {
			const inputs = audio.audio.inputs.map((entry) => ({
				...entry,
				input_id: entry.input_id === "embedded" ? "embedded" : "missing",
			}));
			if (!inputs.some((entry) => entry.input_id === "missing"))
				inputs.push(input("missing"));
			expect(
				refusal(() =>
					startMockStreaming({ ...base, audio: { ...audio.audio, inputs } }),
				),
			).toEqual(invalidMix(audio.token));
			expect(getMockState().engineStart).toBeNull();
		});
	}
}

for (const composition of compositionFailures) {
	test(`Start prioritizes unknown audio identity before ${composition.name}`, () => {
		expect(
			refusal(() =>
				startMockStreaming({
					...base,
					audio: { inputs: [input("missing")] },
					composition: composition.config,
				}),
			),
		).toEqual(unknownInput);
		expect(getMockState().engineStart).toBeNull();
	});
	for (const path of ["start", "live"] as const) {
		test(`${path} preserves ${composition.name} priority and native envelope`, () => {
			if (path === "live") startMockStreaming(base);
			const previous = structuredClone(getMockState().engineStart);
			const action = () =>
				path === "start"
					? startMockStreaming({
							...base,
							audio: { inputs: [input()] },
							composition: composition.config,
						})
					: changeMockComposition(composition.config);
			const expected =
				composition.message === undefined
					? unavailableComposition
					: {
							code: -32602,
							message: `invalid params: ${composition.message}`,
							dataCode: "cerastream.params.invalid",
							data: { code: "cerastream.params.invalid" },
							captureCauses: [],
						};
			expect(refusal(action)).toEqual(expected);
			expect(getMockState().engineStart).toEqual(previous);
		});
	}
	test(`live composition checks session state before ${composition.name}`, () => {
		expect(refusal(() => changeMockComposition(composition.config))).toEqual({
			code: -32001,
			message: "no active stream",
			dataCode: "cerastream.state.not_streaming",
			data: { code: "cerastream.state.not_streaming" },
			captureCauses: [],
		});
	});
}

test("Start checks unknown audio identity before unavailable mix factories", () => {
	expect(
		refusal(() =>
			startMockStreaming({ ...base, audio: { inputs: [input("missing")] } }),
		),
	).toEqual(unknownInput);
});

test("live mix checks admitted session before unknown input and invalid values", () => {
	startMockStreaming(base);
	expect(
		refusal(() =>
			setMockAudioMix({
				inputs: [{ input_id: "missing", gain_db: 13, delay_ms: 2001 }],
			}),
		),
	).toEqual(invalidMix("audio-mix-inactive"));
});

for (const row of [
	{
		name: "unknown identity before invalid values",
		params: { inputs: [{ input_id: "missing", gain_db: 13, delay_ms: 2001 }] },
		expected: unknownInput,
	},
	{
		name: "gain before delay",
		params: { inputs: [{ input_id: first, gain_db: 13, delay_ms: 2001 }] },
		expected: invalidMix("audio-gain-range"),
	},
	{
		name: "first invalid update before later unknown identity",
		params: {
			inputs: [{ input_id: first, delay_ms: 2001 }, { input_id: "missing" }],
		},
		expected: invalidMix("audio-delay-range"),
	},
	{
		name: "first unknown identity before later invalid update",
		params: {
			inputs: [{ input_id: "missing" }, { input_id: first, gain_db: 13 }],
		},
		expected: unknownInput,
	},
] satisfies Array<{
	name: string;
	params: SetAudioMixParams;
	expected: ReturnType<typeof refusal>;
}>) {
	test(`live mix prioritizes ${row.name} atomically`, () => {
		initMockService("caps-full");
		startMockStreaming({ ...base, audio: { inputs: [input()] } });
		const previous = structuredClone(getMockState().engineStart);
		expect(refusal(() => setMockAudioMix(row.params))).toEqual(row.expected);
		expect(getMockState().engineStart).toEqual(previous);
	});
}
