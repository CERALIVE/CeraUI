/*
 * The mock engine answers the way cerastream does. Every `set-audio-mix` result
 * and `audio-level` frame it produces parses with the producer schemas of the
 * installed `@ceralive/cerastream`, every audio-mix refusal carries one of the
 * engine's own tokens, and its test controls (held and refused replies, the last
 * start request, an audio device unplug and replug, idle per-input meters) keep
 * that contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AudioConfig,
	audioLevelEventSchema,
	CerastreamRpcError,
	type StartParams,
	setAudioMixResultSchema,
} from "@ceralive/cerastream";
import type { MockEngineControlInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getMockState,
	initMockService,
	resetMockState,
	stopMockService,
	updateMockState,
} from "../mocks/mock-service.ts";
import { mockAudioLevelFrame } from "../mocks/providers/preview.ts";
import * as engine from "../mocks/providers/streaming.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	deriveAudioSources,
	getAudioDevices,
	setMockAudioDevicesProvider,
} from "../modules/streaming/audio.ts";
import { audioInputEngineId } from "../modules/streaming/audio-inputs.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { setAudioMixProcedure } from "../rpc/procedures/audio-mix.procedure.ts";
import { mockEngineControlProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

// Every audio token cerastream returns, at origin/main 2ad2349e:
// crates/cerastream/src/engine/audio_mix.rs (validate, start),
// crates/cerastream/src/engine/audio_mix/live.rs (set-audio-mix) and
// crates/cerastream/src/engine.rs (switch-audio while mixing).
const ENGINE_AUDIO_TOKENS = [
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
];
const IDLE_INPUT_METERS = "audio-idle-input-meters";

const FIRST = "audio_rode_ai_micro";
const SECOND = "audio_elgato_wave3";
const HDMI = "audio_rockchiphdmiin";
const BASE: StartParams = {
	pipeline: "test",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 120 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "adaptive" },
};
const input = (input_id = FIRST, tracks = [1]) => ({ input_id, tracks });
const start = (audio: AudioConfig) =>
	engine.startMockStreaming({ ...BASE, audio });

function engineToken(error: unknown): string {
	if (!(error instanceof CerastreamRpcError)) throw error;
	expect(error.code).toBe(-32602);
	expect(error.dataCode).toBe("cerastream.params.invalid");
	const token = /^invalid params: ([a-z0-9-]+): /.exec(error.message)?.[1];
	if (token === undefined)
		throw new Error(`no engine token in "${error.message}"`);
	return token;
}

function refusalToken(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		return engineToken(error);
	}
	throw new Error("the mock engine accepted it");
}

async function replyRefusalToken(reply: Promise<unknown>): Promise<string> {
	try {
		await reply;
	} catch (error) {
		return engineToken(error);
	}
	throw new Error("the mock engine accepted it");
}

// The frame as a client decodes it; `pts_us` is the preview channel's own field.
function frameOnWire(seq: number) {
	const wire = JSON.parse(JSON.stringify(mockAudioLevelFrame(seq, seq * 200)));
	const { pts_us: _ptsUs, ...event } = wire;
	expect(audioLevelEventSchema.parse(wire)).toEqual(event);
	return wire as ReturnType<typeof audioLevelEventSchema.parse>;
}

function advertiseIdleInputMeters(): void {
	updateMockState({ capabilityOverride: { features: [IDLE_INPUT_METERS] } });
}

const savedMode = process.env.MOCK_MODE;
let configDirectory: string;
let previousConfigPath: string;
let previousConfig: ReturnType<typeof getConfig>;

// An unplug records the devices seen in the config and saves it, so every test
// owns a private config file whatever directory the suite runs from.
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "mock-engine-"));
	previousConfigPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(configDirectory, "config.json"));
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});

afterEach(async () => {
	setMockAudioDevicesProvider(undefined);
	stopMockService();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousConfigPath);
	await rm(configDirectory, { recursive: true, force: true });
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

describe("refusals carry the engine's own tokens", () => {
	test.each([
		["an empty mix", () => start({ inputs: [] })],
		[
			"five inputs",
			() =>
				start({ inputs: Array.from({ length: 5 }, (_, i) => input(`${i}`)) }),
		],
		[
			"a mix beside a device",
			() => start({ device: FIRST, inputs: [input()] }),
		],
		["a mix with mode none", () => start({ mode: "none", inputs: [input()] })],
		["a duplicate input", () => start({ inputs: [input(), input()] })],
		[
			"embedded audio without a network source",
			() => start({ inputs: [input("embedded")] }),
		],
		["an input without a track", () => start({ inputs: [input(FIRST, [])] })],
		[
			"a gain over the range",
			() => start({ inputs: [{ ...input(), gain_db: 13 }] }),
		],
		[
			"a delay over the range",
			() => start({ inputs: [{ ...input(), delay_ms: 2001 }] }),
		],
		[
			"a gap in the tracks",
			() => start({ inputs: [input(), input(SECOND, [3])] }),
		],
		[
			"a live change with no mix running",
			() => {
				engine.startMockStreaming(BASE);
				engine.setMockAudioMix({ inputs: [] });
			},
		],
		[
			"a live gain under the range",
			() => {
				start({ inputs: [input()] });
				engine.setMockAudioMix({ inputs: [{ input_id: FIRST, gain_db: -61 }] });
			},
		],
		[
			"switch-audio while mixing",
			() => {
				start({ inputs: [input()] });
				engine.switchMockAudio(SECOND);
			},
		],
		[
			"a mix on an engine without audio_mix",
			() => {
				initMockService("multi-modem-wifi");
				start({ inputs: [input()] });
			},
		],
	] satisfies [string, () => unknown][])("%s", (_name, action) => {
		expect(ENGINE_AUDIO_TOKENS).toContain(refusalToken(action));
	});
});

describe("results and frames parse with the producer schemas", () => {
	test("every set-audio-mix result, held or not", async () => {
		start({ inputs: [input(), input(SECOND, [1, 2])] });
		const results = [
			engine.setMockAudioMix({
				inputs: [{ input_id: FIRST, gain_db: -60, delay_ms: 2000 }],
			}),
			engine.setMockAudioMix({
				inputs: [{ input_id: SECOND, mute: true }, { input_id: FIRST }],
			}),
			engine.setMockAudioMix({ inputs: [] }),
			await engine.replyMockAudioMix({
				inputs: [{ input_id: SECOND, gain_db: 12 }],
			}),
		];
		for (const result of results) {
			const wire = JSON.parse(JSON.stringify(result));
			expect(setAudioMixResultSchema.parse(wire)).toEqual(wire);
		}
	});

	test("idle without audio-idle-input-meters, a frame carries no per-input reading, as today's engine omits its empty list", () => {
		const wire = frameOnWire(1);
		expect("inputs" in wire).toBe(false);
		expect(wire.rms_db).toHaveLength(2);
	});

	test("idle with audio-idle-input-meters, every attached audio input reads its own level at unity", () => {
		advertiseIdleInputMeters();
		const wire = frameOnWire(2);
		expect(wire.inputs?.map((reading) => reading.input_id)).toEqual([
			FIRST,
			SECOND,
			HDMI,
		]);
		for (const reading of wire.inputs ?? []) {
			expect(reading).toEqual({
				input_id: reading.input_id,
				channels: 2,
				rms_db: wire.rms_db ?? [],
				peak_db: wire.peak_db ?? [],
			});
		}
	});

	test("live on a mix, the readings follow the admitted gain and mute; live without one, none", () => {
		advertiseIdleInputMeters();
		start({ inputs: [input(), input(SECOND)] });
		engine.setMockAudioMix({
			inputs: [
				{ input_id: FIRST, gain_db: -20 },
				{ input_id: SECOND, mute: true },
			],
		});
		const mixing = frameOnWire(3);
		expect(mixing.inputs?.map((reading) => reading.input_id)).toEqual([
			FIRST,
			SECOND,
		]);
		expect(mixing.inputs?.[0]?.rms_db).toEqual(
			(mixing.rms_db ?? []).map((db) => db - 20),
		);
		expect(mixing.inputs?.[1]?.rms_db).toEqual([-1_000_000, -1_000_000]);

		engine.stopMockStreaming();
		engine.startMockStreaming(BASE);
		expect("inputs" in frameOnWire(4)).toBe(false);
	});
});

describe("an audio device unplug and replug", () => {
	test("leaves and rejoins the audio sources, the engine registry and the idle meters, and clients hear both", () => {
		setMockAudioDevicesProvider(engine.getMockAudioDevices);
		advertiseIdleInputMeters();
		const frames: Array<Record<string, unknown>> = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => frames.push(JSON.parse(message)),
		} as unknown as AppWebSocket;
		const heardAsrcs = () =>
			(
				frames.findLast((frame) => "status" in frame)?.status as {
					asrcs?: string[];
				}
			)?.asrcs;
		addClient(client);
		try {
			engine.setMockDeviceAttached(SECOND, false);

			expect(Object.keys(getAudioDevices())).not.toContain("Elgato Wave:3");
			expect(deriveAudioSources().map((source) => source.id)).not.toContain(
				"Elgato Wave:3",
			);
			expect(
				engine.getMockEngineDevices().devices.map((device) => device.input_id),
			).not.toContain(SECOND);
			expect(frameOnWire(5).inputs?.map((reading) => reading.input_id)).toEqual(
				[FIRST, HDMI],
			);
			expect(heardAsrcs()).not.toContain("Elgato Wave:3");
			expect(() => start({ inputs: [input(SECOND)] })).toThrow(
				"audio device not found",
			);

			engine.setMockDeviceAttached(SECOND, true);

			expect(Object.keys(getAudioDevices())).toContain("Elgato Wave:3");
			expect(deriveAudioSources().map((source) => source.id)).toContain(
				"Elgato Wave:3",
			);
			expect(frameOnWire(6).inputs?.map((reading) => reading.input_id)).toEqual(
				[FIRST, SECOND, HDMI],
			);
			expect(heardAsrcs()).toContain("Elgato Wave:3");
			start({ inputs: [input(SECOND)] });
		} finally {
			removeClient(client);
		}
	});
});

describe("set-audio-mix replies the test holds, releases and refuses", () => {
	test("a held reply is applied on arrival and delivered when released, in the order the test picks", async () => {
		start({ inputs: [input()] });
		engine.holdMockAudioMixReplies(true);
		const order: string[] = [];
		const muted = engine
			.replyMockAudioMix({ inputs: [{ input_id: FIRST, mute: true }] })
			.then((result) => {
				order.push("mute");
				return result;
			});
		const quieter = engine
			.replyMockAudioMix({ inputs: [{ input_id: FIRST, gain_db: -6 }] })
			.then((result) => {
				order.push("gain");
				return result;
			});
		expect(getMockState().engineStart?.audio?.inputs?.[0]).toMatchObject({
			mute: true,
			gain_db: -6,
		});

		expect(engine.releaseMockAudioMixReply(1)).toBe(true);
		expect((await quieter).inputs).toEqual([
			{ input_id: FIRST, gain_db: -6, mute: true, delay_ms: 0 },
		]);
		expect(order).toEqual(["gain"]);
		expect(engine.releaseMockAudioMixReply(0)).toBe(true);
		expect((await muted).inputs).toEqual([
			{ input_id: FIRST, gain_db: 0, mute: true, delay_ms: 0 },
		]);
		expect(order).toEqual(["gain", "mute"]);
		expect(engine.releaseMockAudioMixReply(0)).toBe(false);
	});

	test("a refused reply carries the engine envelope and leaves the mix unchanged; a held refusal arrives on release", async () => {
		start({ inputs: [input()] });
		const before = structuredClone(getMockState().engineStart);
		engine.refuseMockAudioMix("audio-gain-range");
		expect(
			await replyRefusalToken(
				engine.replyMockAudioMix({
					inputs: [{ input_id: FIRST, gain_db: -3 }],
				}),
			),
		).toBe("audio-gain-range");
		expect(getMockState().engineStart).toEqual(before);

		engine.holdMockAudioMixReplies(true);
		const refused = replyRefusalToken(
			engine.replyMockAudioMix({ inputs: [{ input_id: FIRST, mute: true }] }),
		);
		engine.refuseMockAudioMix(null);
		const applied = engine.replyMockAudioMix({
			inputs: [{ input_id: FIRST, mute: false }],
		});
		engine.releaseMockAudioMixReply(1);
		expect((await applied).inputs[0]?.mute).toBe(false);
		engine.releaseMockAudioMixReply(0);
		expect(await refused).toBe("audio-gain-range");
	});

	test("turning the hold off delivers every held reply in arrival order", async () => {
		start({ inputs: [input()] });
		engine.holdMockAudioMixReplies(true);
		const order: number[] = [];
		const replies = [-1, -2, -3].map((gain_db) =>
			engine
				.replyMockAudioMix({ inputs: [{ input_id: FIRST, gain_db }] })
				.then((result) => order.push(result.inputs[0]?.gain_db ?? 0)),
		);
		engine.holdMockAudioMixReplies(false);
		await Promise.all(replies);
		expect(order).toEqual([-1, -2, -3]);
	});

	test("resetting the mock delivers a reply still held, so no call hangs", async () => {
		start({ inputs: [input()] });
		engine.holdMockAudioMixReplies(true);
		const reply = engine.replyMockAudioMix({
			inputs: [{ input_id: FIRST, mute: true }],
		});
		resetMockState();
		expect((await reply).inputs[0]?.mute).toBe(true);
		expect(engine.releaseMockAudioMixReply(0)).toBe(false);
	});
});

describe("the last start request", () => {
	test("is recorded as the engine received it, admitted or refused, and a composition rebuild is not a start", () => {
		expect(engine.getMockLastStartParams()).toBeNull();
		const admitted = { ...BASE, audio: { inputs: [input()] } };
		engine.startMockStreaming(admitted);
		expect(engine.getMockLastStartParams()).toEqual(admitted);
		expect(engine.getMockLastStartParams()).not.toBe(admitted);

		engine.changeMockComposition({
			secondary_input_id: "hdmi",
			layout: "custom",
			rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
		});
		expect(getMockState().engineStart?.composition).toBeDefined();
		expect(engine.getMockLastStartParams()).toEqual(admitted);

		engine.stopMockStreaming();
		const refused = { ...BASE, audio: { inputs: [] } };
		expect(() => engine.startMockStreaming(refused)).toThrow("audio-mix-empty");
		expect(engine.getMockLastStartParams()).toEqual(refused);

		resetMockState();
		expect(engine.getMockLastStartParams()).toBeNull();
	});
});

describe("the e2e channel", () => {
	const control = (input: MockEngineControlInput) =>
		call(mockEngineControlProcedure, input, { context: makeRpcContext() });

	test("streaming.mockEngineControl holds, releases and refuses replies and reads the last start", async () => {
		start({ inputs: [input()] });
		expect(await control({ op: "last_start_params" })).toEqual({
			success: true,
			start_params: { ...BASE, audio: { inputs: [input()] } },
		});

		expect(await control({ op: "hold_audio_mix", hold: true })).toEqual({
			success: true,
		});
		const reply = engine.replyMockAudioMix({
			inputs: [{ input_id: FIRST, mute: true }],
		});
		expect(await control({ op: "release_audio_mix" })).toEqual({
			success: true,
		});
		expect((await reply).inputs[0]?.mute).toBe(true);
		expect(await control({ op: "release_audio_mix", index: 0 })).toEqual({
			success: false,
			error: "no held set-audio-mix reply",
		});

		await control({ op: "hold_audio_mix", hold: false });
		expect(
			await control({ op: "refuse_audio_mix", token: "audio-delay-range" }),
		).toEqual({ success: true });
		expect(
			await replyRefusalToken(
				engine.replyMockAudioMix({
					inputs: [{ input_id: FIRST, mute: false }],
				}),
			),
		).toBe("audio-delay-range");
	});

	test("streaming.mockEngineControl refuses outside mock mode", async () => {
		stopMockService();
		expect(await control({ op: "last_start_params" })).toEqual({
			success: false,
			error: "Mock engine controls only available in development mode",
		});
	});

	test("a live streaming.setAudioMix reaches the engine through those controls", async () => {
		try {
			setMockAudioDevicesProvider(engine.getMockAudioDevices);
			// Boot seeds both caches: the value bounds read the capabilities and the
			// card-to-engine-id join reads the devices.
			await getCapabilities({
				fetchEngineCapabilities: async () => engine.getMockEngineCapabilities(),
				fetchEngineDevices: async () => engine.getMockEngineDevices(),
			});
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => engine.getMockEngineDevices(),
			});
			Object.assign(getConfig(), { asrc: "RØDE AI-Micro", pipeline: "test" });
			start({
				inputs: [input(audioInputEngineId("RØDE AI-Micro", getConfig()))],
			});
			updateStatus(true);
			engine.refuseMockAudioMix("audio-gain-range");

			const result = await call(
				setAudioMixProcedure,
				{ id: "RØDE AI-Micro", mute: true },
				{ context: makeRpcContext() },
			);

			expect(result).toMatchObject({
				success: false,
				error: "cerastream.params.invalid",
				engine_error: {
					code: -32602,
					message:
						"invalid params: audio-gain-range: invalid audio mix configuration",
				},
			});
		} finally {
			resetEngineDeviceCache();
			clearCapabilitiesCache();
			updateStatus(false);
		}
	});
});
