/*
 * A capture device whose SIGNAL appears after CeraUI's first look at it.
 *
 * Reproduced on a Rock 5B+: the RK3588 HDMI-RX answers
 * `VIDIOC_QUERY_DV_TIMINGS` with ENOLINK for the seconds its link spends
 * retraining, so the engine truthfully reports the node with NO caps and
 * `fromEngineDevice` stamps `signal: 'absent'`. Seconds later the kernel logs
 * `signal lock ok` + `New format: 1920x1080p59.94` and the engine's very next
 * `list-devices` carries the real mode — but nothing asked it again, so the UI
 * kept rendering "No signal" for a locked 1080p59.94 source.
 *
 * The device never left the list, so neither hotplug detector could fire. These
 * tests pin the periodic re-probe that closes the gap, and the three rules it
 * must not break while doing so.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	type GetCapabilitiesResult,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { CaptureDevice, StreamSource } from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	createDeviceRegistry,
	type DeviceRegistryDeps,
} from "../modules/streaming/devices.ts";
import {
	applyObservedEngineDevices,
	getEngineDeviceCache,
	getSourcesMessage,
	recheckSourceSignals,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const HDMI_RX_ID = "/dev/video0";

/** The engine's entry for the HDMI-RX node, verbatim from the board. `caps`
 *  absent is the signal-less shape cerastream actually emits — it DROPS the
 *  degenerate range bounds rather than reporting them as modes. */
function hdmiRxEntry(
	caps?: ListDevicesResult["devices"][number]["caps"],
): ListDevicesResult["devices"][number] {
	return {
		input_id: HDMI_RX_ID,
		device_path: HDMI_RX_ID,
		display_name: "rk_hdmirx",
		media_class: "video",
		kind: "hdmi",
		stable_id: "port:fdee0000.hdmirx-controller",
		...(caps !== undefined ? { caps } : {}),
	};
}

/** What `list-devices` returns once the link finishes retraining: the ONE mode
 *  the cable is carrying, derived from the kernel's own pixel clock. */
const LOCKED_1080P5994: ListDevicesResult["devices"][number]["caps"] = [
	{ width: 1920, height: 1080, framerate: "60000/1001" },
];

/** What the registry's own local v4l2 scan sees: the node is present, and that
 *  never changes while the link retrains — only the engine can see the signal. */
function observedHdmiRx(): CaptureDevice[] {
	return [
		{
			input_id: HDMI_RX_ID,
			device_path: HDMI_RX_ID,
			display_name: "HDMI Input",
			media_class: "video",
			kind: "hdmi",
		},
	];
}

function recordingClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

async function seedHdmiCaps(): Promise<void> {
	const caps: GetCapabilitiesResult = {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["h264"],
			bitrate_range: { min: 500, max: 20000, unit: "kbps" },
		},
		sources: [
			{
				id: "hdmi",
				supports_audio: false,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1080p",
				default_framerate: 30,
			},
		],
	};
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

function hdmiSource(): StreamSource | undefined {
	return getSourcesMessage().sources.find((s) => s.id === HDMI_RX_ID);
}

function captureFrames(
	run: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
	const sink: string[] = [];
	const client = recordingClient(sink);
	addClient(client);
	return run()
		.finally(() => removeClient(client))
		.then(() => sink.map((raw) => JSON.parse(raw) as Record<string, unknown>));
}

describe("recheckSourceSignals — a signal that arrives after the first probe", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	test("a device that answered 'no signal' first and a locked mode second transitions to present — no replug, no device-set change", async () => {
		await seedHdmiCaps();

		// FIRST probe: mid-retraining. The engine lists the node and projects
		// nothing, which is a real finding — this is the state that used to latch.
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({ devices: [hdmiRxEntry()] }),
		});
		expect(hdmiSource()?.signal).toBe("absent");

		// SECOND probe: the same node, same id, same display name — the kernel has
		// simply locked onto 1080p59.94 in between. Nothing about the device SET
		// changed, so only this re-probe can carry the news.
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});

		const locked = hdmiSource();
		expect(locked?.signal).toBe("present");
		expect(locked?.available).toBe(true);
		expect(locked?.modes).toEqual([
			{ width: 1920, height: 1080, framerates: [59.94] },
		]);
	});

	test("the transition is pushed to connected clients, so the row corrects itself with no page reload", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({ devices: [hdmiRxEntry()] }),
		});

		const frames = await captureFrames(() =>
			recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: async () => ({
					devices: [hdmiRxEntry(LOCKED_1080P5994)],
				}),
			}),
		);

		const sources = frames.find((f) => "sources" in f)?.sources as
			| { sources: StreamSource[] }
			| undefined;
		expect(sources).toBeDefined();
		expect(sources?.sources.find((s) => s.id === HDMI_RX_ID)?.signal).toBe(
			"present",
		);
	});

	test("a losing signal is reported just as promptly as a gained one", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});
		expect(hdmiSource()?.signal).toBe("present");

		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({ devices: [hdmiRxEntry()] }),
		});
		expect(hdmiSource()?.signal).toBe("absent");
	});

	test("a losing signal is PUSHED just as promptly as a gained one — the badge appears with no page reload", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});

		const frames = await captureFrames(() =>
			recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: async () => ({ devices: [hdmiRxEntry()] }),
			}),
		);

		const sources = frames.find((f) => "sources" in f)?.sources as
			| { sources: StreamSource[] }
			| undefined;
		expect(sources).toBeDefined();
		const pushed = sources?.sources.find((s) => s.id === HDMI_RX_ID);
		expect(pushed?.signal).toBe("absent");
		expect(pushed?.modes).toEqual([]);
	});

	test("a device the probe stops listing drops its verdict to unknown — it never re-asserts the signal it had when last seen", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});
		expect(hdmiSource()?.signal).toBe("present");

		// The scan still sees the node — a v4l2 node does not go away when its
		// cable does — but the engine no longer speaks for it. Restoring the
		// remembered row wholesale republished its LOCKED caps, so the payload
		// never changed and the operator kept reading a live 1080p59.94 source.
		const frames = await captureFrames(() =>
			recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: async () => ({ devices: [] }),
			}),
		);

		expect(hdmiSource()?.signal).toBe("unknown");
		expect(hdmiSource()?.modes).toEqual([]);
		expect(frames.find((f) => "sources" in f)).toBeDefined();
	});

	test("the engine's typed kind still survives that probe — only the live verdict does not", async () => {
		await seedHdmiCaps();
		const observedRode: CaptureDevice[] = [
			{
				input_id: "/dev/video1",
				device_path: "/dev/video1",
				// What the scan can read; `deriveKind` guesses `usb` from it, which
				// bridges to no pipeline (#219) — the reason the memory exists.
				display_name: "RØDE HDMI to USB-C: RØDE HDMI",
				media_class: "video",
				kind: "usb",
			},
		];
		const engineRode = {
			input_id: "/dev/video1",
			device_path: "/dev/video1",
			display_name: "RØDE HDMI to USB-C: RØDE HDMI",
			media_class: "video" as const,
			kind: "mjpeg",
			stable_id: "usb:19f7:0080",
			caps: LOCKED_1080P5994,
		};

		await recheckSourceSignals(observedRode, {
			fetchEngineDevices: async () => ({ devices: [engineRode] }),
		});
		await recheckSourceSignals(observedRode, {
			fetchEngineDevices: async () => ({ devices: [] }),
		});

		const cached = getEngineDeviceCache().find(
			(d) => d.input_id === "/dev/video1",
		);
		expect(cached?.kind).toBe("mjpeg");
		expect(cached?.stable_id).toBe("usb:19f7:0080");
		expect(cached?.caps).toBeUndefined();
		expect(cached?.signal).toBeUndefined();
	});

	test("a probe slower than the tick is not fenced out by its own successor", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});
		expect(hdmiSource()?.signal).toBe("present");

		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const successorProbe = mock(async () => ({ devices: [hdmiRxEntry()] }));

		const frames = await captureFrames(async () => {
			const slow = recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: async () => {
					await held;
					return { devices: [hdmiRxEntry()] };
				},
			});
			// The next 5 s tick, arriving while the enumeration above is still out.
			await recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: successorProbe,
			});
			release?.();
			await slow;
		});

		expect(successorProbe).not.toHaveBeenCalled();
		expect(hdmiSource()?.signal).toBe("absent");
		const sources = frames.find((f) => "sources" in f)?.sources as
			| { sources: StreamSource[] }
			| undefined;
		expect(sources?.sources.find((s) => s.id === HDMI_RX_ID)?.signal).toBe(
			"absent",
		);
	});

	test("an unchanged answer broadcasts NOTHING, so `sources` keeps its on-change cadence", async () => {
		await seedHdmiCaps();
		const answer = async () => ({
			devices: [hdmiRxEntry(LOCKED_1080P5994)],
		});
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: answer,
		});

		const frames = await captureFrames(() =>
			recheckSourceSignals(observedHdmiRx(), { fetchEngineDevices: answer }),
		);
		expect(frames.find((f) => "sources" in f)).toBeUndefined();
	});

	test("a probe that says nothing leaves the last-known view standing — it never republishes the coarse observation", async () => {
		await seedHdmiCaps();
		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});

		// Unlike a hotplug tick, this one detected no transition: with the engine
		// unreachable there is nothing here worth publishing over its last answer.
		const frames = await captureFrames(() =>
			recheckSourceSignals(observedHdmiRx(), {
				fetchEngineDevices: async () => {
					throw new Error("engine unavailable");
				},
			}),
		);

		expect(frames.find((f) => "sources" in f)).toBeUndefined();
		expect(hdmiSource()?.signal).toBe("present");
		expect(getEngineDeviceCache()).toHaveLength(1);
	});

	test("membership still comes from the caller's observation, so a stale answer cannot resurrect an unplugged device", async () => {
		await seedHdmiCaps();
		getConfig().source = HDMI_RX_ID;
		applyObservedEngineDevices([
			{
				input_id: HDMI_RX_ID,
				device_path: HDMI_RX_ID,
				display_name: "rk_hdmirx",
				media_class: "video",
				kind: "hdmi",
			},
		]);

		// The registry no longer sees the node; the probe answers about a moment
		// before it went away. The observation wins, exactly as on the hotplug path.
		await recheckSourceSignals([], {
			fetchEngineDevices: async () => ({
				devices: [hdmiRxEntry(LOCKED_1080P5994)],
			}),
		});

		expect(getEngineDeviceCache()).toHaveLength(0);
		expect(hdmiSource()?.lost).toBe(true);
	});
});

describe("device registry — signal recheck tick", () => {
	function makeDeps(
		overrides: Partial<DeviceRegistryDeps> = {},
	): Partial<DeviceRegistryDeps> {
		return {
			listVideoCards: async () => ["video0"],
			readCardName: async () => "rk_hdmirx",
			getAudioSources: () => ({}),
			getEngine: () => "cerastream",
			isStreaming: () => false,
			engineSwitch: async () => undefined,
			// Idle: CeraUI holds no engine connection, so the registry's own poll is
			// the local v4l2 scan — byte-identical on every tick forever.
			getEngineDevices: async () => null,
			getSelectedVideoInput: () => undefined,
			clearSelectedVideoInput: () => undefined,
			notify: () => undefined,
			broadcast: () => undefined,
			onDevicesChanged: () => undefined,
			onSignalRecheck: () => undefined,
			watch: (() => {
				throw new Error("no /dev watch in tests");
			}) as unknown as DeviceRegistryDeps["watch"],
			now: () => 0,
			pollMs: 10_000,
			signalRecheckMs: 5,
			logger: { debug() {}, warn() {}, error() {} },
			...overrides,
		};
	}

	test("fires on its interval even though the device set never changes, handing over the list it observed", async () => {
		const onSignalRecheck = mock(() => undefined);
		const onDevicesChanged = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({ onSignalRecheck, onDevicesChanged }),
		);

		registry.start();
		await Bun.sleep(40);
		registry.stop();

		expect(onSignalRecheck.mock.calls.length).toBeGreaterThan(0);
		// The set was stable throughout, which is precisely why the hotplug trigger
		// stayed silent and the recheck had to exist.
		expect(onDevicesChanged).not.toHaveBeenCalled();
		expect(onSignalRecheck.mock.calls[0]?.[0]).toEqual(registry.getDevices());
	});

	test("stop() clears the tick — a stopped registry never re-probes the engine", async () => {
		const onSignalRecheck = mock(() => undefined);
		const registry = createDeviceRegistry(makeDeps({ onSignalRecheck }));

		registry.start();
		await Bun.sleep(30);
		registry.stop();
		const afterStop = onSignalRecheck.mock.calls.length;

		await Bun.sleep(30);
		expect(onSignalRecheck.mock.calls.length).toBe(afterStop);
	});
});
