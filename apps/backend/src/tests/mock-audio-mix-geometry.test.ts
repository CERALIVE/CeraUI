import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	type AudioConfig,
	CerastreamRpcError,
	type CompositionConfig,
	type StartParams,
} from "@ceralive/cerastream";
import {
	getMockState,
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	startMockPreviewServer,
	stopMockPreviewServer,
} from "../mocks/providers/preview.ts";
import * as engine from "../mocks/providers/streaming.ts";

const savedMode = process.env.MOCK_MODE;
const first = "audio_rode_ai_micro";
const second = "audio_elgato_wave3";
const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
const base: StartParams = {
	pipeline: "test",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 120 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "adaptive" },
};
const input = (input_id = first, tracks = [1]) => ({ input_id, tracks });
const start = (audio: AudioConfig) =>
	engine.startMockStreaming({ ...base, audio });

beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});
afterEach(() => {
	stopMockPreviewServer();
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

test.each([
	["audio-mix-empty", { inputs: [] }],
	[
		"audio-mix-too-many-inputs",
		{ inputs: Array.from({ length: 5 }, (_, i) => input(`${i}`)) },
	],
	["audio-mix-duplicate-input", { inputs: [input(), input()] }],
	["audio-tracks-invalid", { inputs: [input(first, [])] }],
	["audio-tracks-invalid", { inputs: [input(first, [0])] }],
	["audio-tracks-invalid", { inputs: [input(first, [5])] }],
	["audio-tracks-invalid", { inputs: [input(first, [1, 1])] }],
	["audio-tracks-gap", { inputs: [input(first, [2])] }],
	["audio-tracks-gap", { inputs: [input(), input(second, [3])] }],
	["audio-gain-range", { inputs: [{ ...input(), gain_db: -61 }] }],
	["audio-gain-range", { inputs: [{ ...input(), gain_db: 13 }] }],
	["audio-delay-range", { inputs: [{ ...input(), delay_ms: 2001 }] }],
	["audio-mix-with-device", { device: first, inputs: [input()] }],
	["audio-mix-with-mode-none", { mode: "none", inputs: [input()] }],
	[
		"audio-mix-embedded-without-network-source",
		{ inputs: [input("embedded")] },
	],
] satisfies [string, AudioConfig][])(
	"mock start refuses %s without activating",
	(token, audio) => {
		expect(() => start(audio)).toThrow(token);
		expect(getMockState().streaming.isActive).toBe(false);
	},
);

test("a legacy start keeps the mix inactive", () => {
	engine.startMockStreaming(base);
	expect(() => engine.setMockAudioMix({ inputs: [] })).toThrow(
		"audio-mix-inactive",
	);
});

test("the default scenario refuses audio mix and custom geometry", () => {
	initMockService("multi-modem-wifi");
	expect(() => start({ inputs: [input()] })).toThrow("audio-mix-unsupported");
	expect(() =>
		engine.startMockStreaming({
			...base,
			composition: { secondary_input_id: "hdmi", layout: "custom", rect },
		}),
	).toThrow("composition-geometry-unsupported");
});

test("live input changes echo defaults and retain membership and tracks", () => {
	start({ inputs: [input(), input(second, [1, 2])] });
	const applied = engine.setMockAudioMix({
		inputs: [
			{ input_id: first, gain_db: -60, delay_ms: 2000 },
			{ input_id: second, gain_db: 12, mute: true },
		],
	});
	expect(applied.inputs).toEqual([
		{ input_id: first, gain_db: -60, mute: false, delay_ms: 2000 },
		{ input_id: second, gain_db: 12, mute: true, delay_ms: 0 },
	]);
	expect(
		getMockState().engineStart?.audio?.inputs?.map((entry) => entry.tracks),
	).toEqual([[1], [1, 2]]);
	expect(() => engine.switchMockAudio(first)).toThrow("audio-mix-active");
});

test("live batches validate every update atomically including repeated ids", () => {
	start({ inputs: [input(), input(second)] });
	expect(() =>
		engine.setMockAudioMix({
			inputs: [
				{ input_id: first, gain_db: -20 },
				{ input_id: second, delay_ms: 2001 },
			],
		}),
	).toThrow("audio-delay-range");
	expect(
		engine.setMockAudioMix({ inputs: [{ input_id: first }] }).inputs[0]
			?.gain_db,
	).toBe(0);
	expect(() =>
		engine.setMockAudioMix({
			inputs: [
				{ input_id: first, gain_db: 13 },
				{ input_id: first, gain_db: 0 },
			],
		}),
	).toThrow("audio-gain-range");
	expect(() =>
		engine.setMockAudioMix({ inputs: [{ input_id: "missing" }] }),
	).toThrow("missing");
});

test("unknown inputs carry the engine audio device error at start and live", () => {
	for (const action of [
		() => start({ inputs: [input("missing")] }),
		() => {
			start({ inputs: [input()] });
			engine.setMockAudioMix({ inputs: [{ input_id: "missing" }] });
		},
	]) {
		expect(action).toThrow(CerastreamRpcError);
		try {
			action();
		} catch (error) {
			expect(error).toMatchObject({
				code: -32006,
				dataCode: "cerastream.audio.device_not_found",
			});
		}
	}
});

test("all four inputs and tracks accept their exact limits", () => {
	engine.startMockStreaming({
		...base,
		pipeline: "rtmp",
		audio: {
			inputs: [
				input(first, [1]),
				input(second, [2]),
				input("audio_rockchiphdmiin", [3]),
				input("embedded", [4]),
			],
		},
	});
	expect(engine.setMockAudioMix({ inputs: [] })).toEqual({ inputs: [] });
	engine.stopMockStreaming();
	expect(() => engine.setMockAudioMix({ inputs: [] })).toThrow(
		"audio-mix-inactive",
	);
});

test("embedded audio is accepted only on a network source and resets with the session", () => {
	engine.startMockStreaming({
		...base,
		pipeline: "srt",
		audio: { inputs: [input("embedded")] },
	});
	expect(
		engine.setMockAudioMix({ inputs: [{ input_id: "embedded", mute: true }] })
			.inputs[0]?.mute,
	).toBe(true);
	resetMockState();
	expect(() => engine.setMockAudioMix({ inputs: [] })).toThrow(
		"audio-mix-inactive",
	);
});

test.each([
	["composition-rect-missing", { layout: "custom" }],
	["composition-rect-unexpected", { layout: "pip-top-right", rect }],
	[
		"composition-rect-range",
		{ layout: "custom", rect: { ...rect, width: 0.05 } },
	],
	["composition-rect-range", { layout: "custom", rect: { ...rect, x: -0.1 } }],
	["composition-rect-range", { layout: "custom", rect: { ...rect, x: 0.75 } }],
	[
		"composition-rect-range",
		{ layout: "custom", rect: { ...rect, height: 0.05 } },
	],
	["composition-rect-range", { layout: "custom", rect: { ...rect, y: 0.75 } }],
] satisfies [string, Omit<CompositionConfig, "secondary_input_id">][])(
	"mock geometry refuses %s at start and live",
	(token, config) => {
		const composition = { secondary_input_id: "hdmi", ...config };
		expect(() => engine.startMockStreaming({ ...base, composition })).toThrow(
			token,
		);
		engine.startMockStreaming(base);
		expect(() => engine.changeMockComposition(composition)).toThrow(token);
	},
);

test("custom geometry survives live changes without replacing audio state", () => {
	start({ inputs: [input()] });
	const composition: CompositionConfig = {
		secondary_input_id: "hdmi",
		layout: "custom",
		rect,
	};
	engine.changeMockComposition(composition);
	expect(getMockState().engineStart?.composition).toEqual(composition);
	expect(
		engine.setMockAudioMix({ inputs: [{ input_id: first }] }).inputs,
	).toHaveLength(1);
});

test("an idle geometry change returns the engine not-streaming error", () => {
	expect(() =>
		engine.changeMockComposition({
			secondary_input_id: "hdmi",
			layout: "custom",
			rect,
		}),
	).toThrow(CerastreamRpcError);
});

test("mix refusals use the producer RPC error class and code", () => {
	try {
		start({ inputs: [] });
		throw new Error("start accepted an empty mix");
	} catch (error) {
		expect(error).toBeInstanceOf(CerastreamRpcError);
		expect(error).toHaveProperty("code", -32602);
	}
});

test("preview input meters reflect admitted gain and mute while the legacy meter remains", async () => {
	start({ inputs: [input(), input(second)] });
	engine.setMockAudioMix({
		inputs: [
			{ input_id: first, gain_db: -20 },
			{ input_id: second, mute: true },
		],
	});
	const server = startMockPreviewServer(0);
	if (!server) throw new Error("mock preview did not start");
	const ws = new WebSocket(`ws://localhost:${server.port}`);
	const received = new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("no audio input levels")),
			3000,
		);
		ws.onopen = () =>
			ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("preview failed"));
		};
		ws.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			const value = JSON.parse(event.data);
			if (value.type !== "audio-level") return;
			clearTimeout(timer);
			resolve(value);
		};
	});
	try {
		const frame = await received;
		expect(frame.rms_db).toEqual([-24, -20.1]);
		expect(frame.inputs).toEqual([
			{
				input_id: first,
				channels: 2,
				rms_db: [-44, -40.1],
				peak_db: [-41, -37.1],
			},
			{
				input_id: second,
				channels: 2,
				rms_db: [-1_000_000, -1_000_000],
				peak_db: [-1_000_000, -1_000_000],
			},
		]);
	} finally {
		ws.close();
	}
});
