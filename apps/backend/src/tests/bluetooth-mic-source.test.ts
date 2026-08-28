import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import {
	AudioProbeTimeoutError,
	asrcProbe,
	deriveAudioSources,
	getAudioDevices,
	refreshBluetoothAudioDevices,
	resolveAudioMode,
	resolveMeterPreference,
} from "../modules/streaming/audio.ts";
import type { EngineAudioDevice } from "../modules/streaming/audio-naming.ts";
import {
	type BluealsaCapturePcm,
	type BluetoothAudioDevice,
	bluealsaScoPcmSpec,
	bluetoothAudioSourceId,
	deriveBluetoothAudioSources,
	deriveBluetoothMicQuality,
	getBluetoothAudioSources,
	noteBluetoothRegistryDevices,
	parseBluealsaCapturePcms,
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import {
	getEngineAudioDevices,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

const MIC_ADDRESS = "AA:BB:CC:11:22:33";
const MIC_ID = "bt:AA_BB_CC_11_22_33";
const MIC_SPEC = "bluealsa:DEV=AA:BB:CC:11:22:33,PROFILE=sco";

function hfpMic(
	overrides: Partial<BluetoothAudioDevice> = {},
): BluetoothAudioDevice {
	return {
		address: MIC_ADDRESS,
		alias: "Jabra Talk 45",
		name: "Jabra Talk 45",
		connected: true,
		scoCapable: true,
		...overrides,
	};
}

function scoPcm(
	overrides: Partial<BluealsaCapturePcm> = {},
): BluealsaCapturePcm {
	return {
		path: "/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
		address: MIC_ADDRESS,
		codec: "mSBC",
		sampleRateHz: 16_000,
		channels: 1,
		...overrides,
	};
}

function pipewireNode(
	overrides: Partial<EngineAudioDevice> = {},
): EngineAudioDevice {
	return {
		input_id: "bluez_input.AA_BB_CC_11_22_33.0",
		display_name: "Jabra Talk 45",
		device_address: MIC_ADDRESS,
		...overrides,
	};
}

function variant(signature: string, value: unknown) {
	return { signature, value };
}

/** A `GetManagedObjects` body in the shape `org.bluealsa` really replies with. */
function managedObjects(
	entries: readonly (readonly [
		string,
		readonly (readonly [string, unknown])[],
	])[],
) {
	return entries.map(([path, props]) => [
		path,
		[["org.bluealsa.PCM1", props.map(([k, v]) => [k, v])]],
	]);
}

function installDeps(options: {
	devices?: readonly BluetoothAudioDevice[];
	pcms?: BluealsaCapturePcm[] | undefined;
	engineSupportsPcmSpec?: boolean;
	engineSupportsPipewireCapture?: boolean;
	engineDevices?: readonly EngineAudioDevice[];
	onBluealsaRead?: () => void;
}) {
	noteBluetoothRegistryDevices(options.devices ?? [hfpMic()]);
	setBluetoothAudioDepsForTest({
		readEnumeratedPcms: async () => {
			options.onBluealsaRead?.();
			return options.pcms === undefined && "pcms" in options
				? undefined
				: (options.pcms ?? [scoPcm()]);
		},
		readRegistryDevices: () => [...(options.devices ?? [hfpMic()])],
		engineSupportsPcmSpec: () => options.engineSupportsPcmSpec ?? true,
		engineSupportsPipewireCapture: () =>
			options.engineSupportsPipewireCapture ?? false,
		readEngineAudioDevices: () => [...(options.engineDevices ?? [])],
	});
}

describe("Bluetooth microphone as an audio source", () => {
	beforeEach(() => {
		resetBluetoothAudioForTest();
		resetEngineDeviceCache();
	});

	afterEach(async () => {
		delete getConfig().asrc;
		resetBluetoothAudioForTest();
		resetEngineDeviceCache();
		setBluetoothAudioDepsForTest({
			readEnumeratedPcms: async () => [],
			readRegistryDevices: () => [],
			engineSupportsPcmSpec: () => true,
			engineSupportsPipewireCapture: () => false,
			readEngineAudioDevices: () => [],
		});
		await refreshBluetoothAudioDevices();
		resetBluetoothAudioForTest();
	});

	describe("the PipeWire engine node is the presence oracle", () => {
		test("the additive engine payload survives the real list-devices projection", async () => {
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices: [
						{
							input_id: "bluez_input.AA_BB_CC_11_22_33.0",
							device_path: "bluez_input.AA_BB_CC_11_22_33.0",
							display_name: "Jabra Talk 45",
							media_class: "audio",
							device_address: MIC_ADDRESS,
						},
					],
				}),
			});

			expect(getEngineAudioDevices()).toEqual([pipewireNode()]);

			installDeps({
				engineSupportsPipewireCapture: true,
				engineDevices: getEngineAudioDevices(),
			});
			await refreshBluetoothAudioDevices();
			expect(getAudioDevices()[MIC_ID]).toBe("bluez_input.AA_BB_CC_11_22_33.0");
		});

		test("pipewire-capture matches device_address case-insensitively and routes node.name unchanged", async () => {
			let bluealsaReads = 0;
			installDeps({
				engineSupportsPipewireCapture: true,
				engineDevices: [
					pipewireNode({ device_address: MIC_ADDRESS.toLowerCase() }),
				],
				onBluealsaRead: () => {
					bluealsaReads += 1;
				},
			});

			await refreshBluetoothAudioDevices();

			expect(bluealsaReads).toBe(0);
			expect(getAudioDevices()[MIC_ID]).toBe("bluez_input.AA_BB_CC_11_22_33.0");
			expect(resolveAudioMode(MIC_ID, false)).toEqual({
				mode: "device",
				device: "bluez_input.AA_BB_CC_11_22_33.0",
			});
		});

		test("pipewire-capture with no matching node publishes no row even when BlueALSA has one", async () => {
			installDeps({
				engineSupportsPipewireCapture: true,
				engineDevices: [pipewireNode({ device_address: "00:11:22:33:44:55" })],
				pcms: [scoPcm()],
			});

			await refreshBluetoothAudioDevices();

			expect(getAudioDevices()[MIC_ID]).toBeUndefined();
			expect(deriveAudioSources().some((source) => source.id === MIC_ID)).toBe(
				false,
			);
		});

		test("a pre-migration bt: selection resolves after reboot without changing one byte", async () => {
			getConfig().asrc = MIC_ID;
			installDeps({
				engineSupportsPipewireCapture: true,
				engineDevices: [pipewireNode()],
			});

			await refreshBluetoothAudioDevices();

			expect(getConfig().asrc).toBe(MIC_ID);
			expect(resolveMeterPreference(getConfig().asrc)).toBe(
				"bluez_input.AA_BB_CC_11_22_33.0",
			);
		});
	});

	describe("the BlueALSA PCM is the presence oracle", () => {
		test("a CONNECTED + scoCapable device WITH a capture PCM becomes one source entry", () => {
			const sources = deriveBluetoothAudioSources({
				devices: [hfpMic()],
				pcms: [scoPcm()],
				engineSupportsPcmSpec: true,
			});

			expect(sources).toEqual([
				{
					id: MIC_ID,
					address: MIC_ADDRESS,
					displayName: "Jabra Talk 45",
					pcmSpec: MIC_SPEC,
					quality: { codec: "msbc", sample_rate_hz: 16_000, channels: 1 },
					unavailableReason: undefined,
				},
			]);
		});

		test("CONNECTED with NO capture PCM yields NO row — BlueZ connected-state never satisfies it", () => {
			expect(
				deriveBluetoothAudioSources({
					devices: [hfpMic({ connected: true })],
					pcms: [],
					engineSupportsPcmSpec: true,
				}),
			).toEqual([]);
		});

		test("an A2DP-source-only device yields NO mic row even with a PCM present", () => {
			expect(
				deriveBluetoothAudioSources({
					devices: [hfpMic({ scoCapable: false })],
					pcms: [scoPcm()],
					engineSupportsPcmSpec: true,
				}),
			).toEqual([]);
		});

		test("a DISCONNECTED device yields no row", () => {
			expect(
				deriveBluetoothAudioSources({
					devices: [hfpMic({ connected: false })],
					pcms: [scoPcm()],
					engineSupportsPcmSpec: true,
				}),
			).toEqual([]);
		});

		test("a PCM for a device the registry never mentioned is not published unnamed", () => {
			expect(
				deriveBluetoothAudioSources({
					devices: [],
					pcms: [scoPcm()],
					engineSupportsPcmSpec: true,
				}),
			).toEqual([]);
		});
	});

	describe("the engine feature gate", () => {
		test("without `audio-pcm-spec` the row is LISTED but disabled-with-reason", () => {
			const [source] = deriveBluetoothAudioSources({
				devices: [hfpMic()],
				pcms: [scoPcm()],
				engineSupportsPcmSpec: false,
			});

			expect(source?.unavailableReason).toBe("engine_update_required");
		});

		test("a gated row never enters the pick map, so it can never be routed", async () => {
			installDeps({ engineSupportsPcmSpec: false });
			await refreshBluetoothAudioDevices();

			expect(Object.keys(getAudioDevices())).not.toContain(MIC_ID);
			expect(deriveAudioSources().find((s) => s.id === MIC_ID)).toMatchObject({
				transport: "bluetooth",
				unavailable_reason: "engine_update_required",
			});
		});

		test("with the token present the row IS selectable", async () => {
			installDeps({ engineSupportsPcmSpec: true });
			await refreshBluetoothAudioDevices();

			expect(getAudioDevices()[MIC_ID]).toBe(MIC_SPEC);
			expect(deriveAudioSources().find((s) => s.id === MIC_ID)).toMatchObject({
				transport: "bluetooth",
				pcm_spec: MIC_SPEC,
				label: "Jabra Talk 45",
			});
			expect(
				deriveAudioSources().find((s) => s.id === MIC_ID)?.unavailable_reason,
			).toBeUndefined();
		});
	});

	describe("the negotiated quality", () => {
		test("mSBC reads as 16 kHz mono", () => {
			expect(deriveBluetoothMicQuality({ codec: "mSBC" })).toEqual({
				codec: "msbc",
				sample_rate_hz: 16_000,
				channels: 1,
			});
		});

		test("CVSD reads as 8 kHz mono", () => {
			expect(deriveBluetoothMicQuality({ codec: "CVSD" })).toEqual({
				codec: "cvsd",
				sample_rate_hz: 8_000,
				channels: 1,
			});
		});

		test("a rate the PCM actually reported outranks the codec default", () => {
			expect(
				deriveBluetoothMicQuality({
					codec: "CVSD",
					sampleRateHz: 16_000,
					channels: 1,
				}),
			).toMatchObject({ codec: "cvsd", sample_rate_hz: 16_000 });
		});

		test("an unreadable codec yields NOTHING, so the UI renders the honest ceiling", () => {
			expect(deriveBluetoothMicQuality({ codec: undefined })).toBeUndefined();
			expect(deriveBluetoothMicQuality({ codec: "SBC" })).toBeUndefined();
		});
	});

	describe("the org.bluealsa PCM parser", () => {
		test("keeps a SCO SOURCE pcm and reads its negotiated fields", () => {
			const pcms = parseBluealsaCapturePcms(
				managedObjects([
					[
						"/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
						[
							["Device", variant("o", "/org/bluez/hci0/dev_AA_BB_CC_11_22_33")],
							["Transport", variant("s", "HFP-AG")],
							["Mode", variant("s", "source")],
							["Codec", variant("s", "mSBC")],
							["Sampling", variant("u", 16_000)],
							["Channels", variant("y", 1)],
						],
					],
				]) as never,
			);

			expect(pcms).toEqual([
				{
					path: "/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
					address: MIC_ADDRESS,
					codec: "mSBC",
					sampleRateHz: 16_000,
					channels: 1,
				},
			]);
		});

		test("drops a SINK pcm and an A2DP source — neither is a microphone", () => {
			const pcms = parseBluealsaCapturePcms(
				managedObjects([
					[
						"/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/sink",
						[
							["Transport", variant("s", "HFP-AG")],
							["Mode", variant("s", "sink")],
						],
					],
					[
						"/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/a2dpsrc/source",
						[
							["Transport", variant("s", "A2DP-source")],
							["Mode", variant("s", "source")],
						],
					],
				]) as never,
			);

			expect(pcms).toEqual([]);
		});

		test("accepts the bluez-alsa 3.x `SCO-AG` transport spelling too", () => {
			const pcms = parseBluealsaCapturePcms(
				managedObjects([
					[
						"/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
						[
							["Transport", variant("s", "SCO-AG")],
							["Mode", variant("s", "source")],
							["Codec", variant("s", "CVSD")],
						],
					],
				]) as never,
			);

			expect(pcms).toHaveLength(1);
			expect(pcms[0]?.address).toBe(MIC_ADDRESS);
		});

		test("a malformed or foreign payload degrades to an empty list, never a throw", () => {
			expect(parseBluealsaCapturePcms(undefined)).toEqual([]);
			expect(parseBluealsaCapturePcms("nonsense" as never)).toEqual([]);
			expect(parseBluealsaCapturePcms([[1, 2]] as never)).toEqual([]);
		});
	});

	describe("selection routes through the EXISTING AudioConfig.device seam", () => {
		test("the pick resolves to the verbatim BlueALSA spec, mode=device", async () => {
			installDeps({});
			await refreshBluetoothAudioDevices();

			expect(resolveAudioMode(MIC_ID, false)).toEqual({
				mode: "device",
				device: MIC_SPEC,
			});
		});

		test("the idle meter preference is the same BlueALSA string", async () => {
			installDeps({});
			await refreshBluetoothAudioDevices();

			expect(resolveMeterPreference(MIC_ID)).toBe(MIC_SPEC);
		});

		test("an ordinary ALSA card still resolves exactly as before", () => {
			expect(resolveAudioMode("usbaudio", false)).toEqual({
				mode: "device",
				device: "hw:CARD=usbaudio",
			});
		});
	});

	describe("the start probe", () => {
		test("PASSES once the capture PCM is present", async () => {
			installDeps({});
			await refreshBluetoothAudioDevices();

			await expect(asrcProbe(MIC_ID)).resolves.toBe(MIC_SPEC);
		});

		test("FAILS when the device is connected but publishes no capture PCM", async () => {
			installDeps({ pcms: [] });
			await refreshBluetoothAudioDevices();
			getConfig().asrc = MIC_ID;

			expect(getAudioDevices()[MIC_ID]).toBeUndefined();

			const err = new AudioProbeTimeoutError(MIC_ID);
			expect(err.name).toBe("AudioProbeTimeoutError");
			expect(err.message).toContain("Jabra Talk 45");
			expect(err.message).toContain("still connected");
			expect(err.message).toContain("no Bluetooth audio capture stream");
		});

		test("the enriched detail names the registry's DISCONNECTED state", async () => {
			installDeps({ devices: [hfpMic({ connected: false })], pcms: [] });
			await refreshBluetoothAudioDevices();

			expect(new AudioProbeTimeoutError(MIC_ID).message).toContain(
				"no longer connected",
			);
		});

		test("a NON-bluetooth failure message is byte-unchanged", () => {
			expect(new AudioProbeTimeoutError("usbaudio").message).toContain(
				"Audio device 'usbaudio'",
			);
		});
	});

	describe("id and spec derivation", () => {
		test("the id is address-derived and stable across a rename", () => {
			expect(bluetoothAudioSourceId(MIC_ADDRESS)).toBe(MIC_ID);
			expect(bluetoothAudioSourceId(MIC_ADDRESS.toLowerCase())).toBe(MIC_ID);
		});

		test("the pcm spec is the SCO profile string the engine opens", () => {
			expect(bluealsaScoPcmSpec(MIC_ADDRESS.toLowerCase())).toBe(MIC_SPEC);
		});
	});

	describe("an unreadable bus RETAINS the previous list", () => {
		test("a failed enumeration does not retract a working microphone", async () => {
			installDeps({});
			await refreshBluetoothAudioDevices();
			expect(getBluetoothAudioSources()).toHaveLength(1);

			setBluetoothAudioDepsForTest({
				readEnumeratedPcms: async () => undefined,
				readRegistryDevices: () => [hfpMic()],
				engineSupportsPcmSpec: () => true,
				engineSupportsPipewireCapture: () => false,
				readEngineAudioDevices: () => [],
			});
			await refreshBluetoothAudioDevices();

			expect(getBluetoothAudioSources()).toHaveLength(1);
			expect(getAudioDevices()[MIC_ID]).toBe(MIC_SPEC);
		});
	});
});
