// @vitest-environment jsdom
/**
 * A cleared setting is sent as cleared and shown cleared (GAP-2).
 *
 * The device stores a cleared setting as absent, and JSON drops an absent key,
 * so a `config` frame cannot say "gone": the store keeps whatever it last held.
 * After every write that clears a key the device also sends
 * `config_clear { keys }`, and the store deletes exactly those keys. Each case
 * clicks like a person through the closed-loop harness: the real store, and the
 * device itself in a process of its own (`real-device.ts`), whose frames are
 * delivered as the exact bytes it sent, then its reply.
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const rpcStub = vi.hoisted(() => ({
	streaming: undefined as unknown,
	system: {
		mintPreviewToken: async () => ({ token: "tok-1", ttlMs: 30_000 }),
	},
}));
// Every importer of the client (components, SystemHelper, the store) gets the stub.
vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	rpc: rpcStub,
}));

import { startStreaming } from "$lib/helpers/SystemHelper";
import {
	destroyDirtyRegistry,
	isPending,
	markPending,
	onRpcResolved,
} from "$lib/rpc/dirty-registry.svelte";
import {
	getConfig,
	ingestPulledConfig,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import type { EncoderConfig } from "../../main/dialogs/EncoderDialog.svelte";
import EncoderDialog from "../../main/dialogs/EncoderDialog.svelte";
import { type HeldRpc, heldRpc, ingest, ingestFrame } from "./device-loop";
import MixerOnStore from "./MixerOnStore.svelte";
import { DEVICE_START_MS, type RealDevice, realDevice } from "./real-device";

const MAIN = "usb-a";
const SECOND = "usb-b";
const AT_DEFAULTS = { tracks: [1], gain_db: 0, mute: false, delay_ms: 0 };

let held: HeldRpc;
let device: RealDevice;

const kind = (frame: string) => Object.keys(JSON.parse(frame))[0];

/** The device stored the mix as absent: `config` without it, then its clear. */
function expectMixCleared(frames: readonly string[]): void {
	expect(frames.map(kind)).toEqual(["config", "config_clear"]);
	const [config, clear] = frames.map((frame) => JSON.parse(frame));
	expect(config.config).not.toHaveProperty("audio_inputs");
	expect(clear.config_clear).toEqual({ keys: ["audio_inputs"] });
}

beforeAll(async () => {
	device = await realDevice();
	// bits-ui's Slider installs a ResizeObserver, absent in jsdom.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
}, DEVICE_START_MS);

afterAll(() => device.close());

beforeEach(() => {
	resetState();
	destroyDirtyRegistry();
	held = heldRpc();
	rpcStub.streaming = held.streaming;
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	resetState();
	destroyDirtyRegistry();
});

/** The idle device the mixer reads: two microphones and a 4x4 mix. */
async function idleDevice(config: Record<string, unknown>): Promise<void> {
	ingest("capabilities", {
		audio_mix: {
			max_inputs: 4,
			max_tracks: 4,
			gain_db_min: -60,
			gain_db_max: 12,
			delay_ms_max: 2000,
		},
	});
	ingest("status", {
		is_streaming: false,
		asrcs: [MAIN, SECOND],
		audio_sources: [
			{ id: MAIN, kind: "device", label: "RODE AI-Micro" },
			{ id: SECOND, kind: "device", label: "Elgato Wave:3" },
		],
	});
	await device.become({ asrc: MAIN, ...config });
}

describe("the mixer shows a cleared mix as cleared", () => {
	it("(1) idle unmute of a default primary: the button ends unmuted after the reply and the echo", async () => {
		await idleDevice({
			audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, mute: true }],
		});
		render(MixerOnStore);
		const mute = screen.getByTestId(`audio-strip-mute-${MAIN}`);
		expect(mute.getAttribute("aria-pressed")).toBe("true");

		await fireEvent.click(mute);
		const unmute = await held.next("setAudioMix");
		expect(unmute.input).toEqual({ id: MAIN, mute: false });
		expectMixCleared(await device.answer(unmute));

		expect(
			screen
				.getByTestId(`audio-strip-mute-${MAIN}`)
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(Object.hasOwn(getConfig() ?? {}, "audio_inputs")).toBe(false);
	});

	it("a delayed idle mute success cannot undo a newer unmute and clear", async () => {
		await idleDevice({});
		render(MixerOnStore);
		const mute = screen.getByTestId(`audio-strip-mute-${MAIN}`);
		await fireEvent.click(mute);
		const pending = await held.next("setAudioMix");
		expect(pending.input).toEqual({ id: MAIN, mute: true });
		const muted = await device.call(pending.method, pending.input);
		expect(muted.result).toMatchObject({
			success: true,
			applied: { mute: true },
		});
		for (const frame of muted.frames) ingestFrame(frame);
		expect(getConfig()?.audio_inputs?.[0]?.mute).toBe(true);

		// A second tab unmutes while this tab still waits for its own reply.
		const unmuted = await device.call("setAudioMix", { id: MAIN, mute: false });
		expect(unmuted.result).toMatchObject({
			success: true,
			applied: { mute: false },
		});
		expectMixCleared(unmuted.frames);
		for (const frame of unmuted.frames) ingestFrame(frame);
		expect(Object.hasOwn(getConfig() ?? {}, "audio_inputs")).toBe(false);

		pending.resolve(muted.result);
		await tick();
		flushSync();
		expect(mute.getAttribute("aria-pressed")).toBe("false");
		expect(
			screen.getByTestId(`audio-strip-error-${MAIN}`).textContent?.trim(),
		).toBe("");
	});

	it("(2) primary on Tracks 1+2, remove Track 2: shows Track 1 only", async () => {
		await idleDevice({
			audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, tracks: [1, 2] }],
		});
		render(MixerOnStore);
		expect(
			screen
				.getByTestId(`audio-strip-track-${MAIN}-2`)
				.getAttribute("aria-pressed"),
		).toBe("true");

		await fireEvent.click(screen.getByTestId(`audio-strip-track-${MAIN}-2`));
		expectMixCleared(await device.answer(await held.next("setAudioMix")));

		expect(held.calls[0]?.input).toEqual({
			id: MAIN,
			track: { number: 2, on: false },
		});
		expect(
			screen
				.getByTestId(`audio-strip-track-${MAIN}-1`)
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen
				.getByTestId(`audio-strip-track-${MAIN}-2`)
				.getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("(3) include a secondary, then exclude it: shows excluded", async () => {
		await idleDevice({});
		render(MixerOnStore);
		const enable = () => screen.getByTestId(`audio-strip-enable-${SECOND}`);
		expect(enable().getAttribute("aria-checked")).toBe("false");

		await fireEvent.click(enable());
		const include = await held.next("setAudioMix");
		expect(include.input).toEqual({ id: SECOND, include: true });
		await device.answer(include);
		expect(enable().getAttribute("aria-checked")).toBe("true");

		await fireEvent.click(enable());
		expectMixCleared(await device.answer(await held.next("setAudioMix")));

		expect(held.calls[1]?.input).toEqual({ id: SECOND, include: false });
		expect(enable().getAttribute("aria-checked")).toBe("false");
	});

	it("(4) primary at -6 dB, reset: shows 0 dB", async () => {
		await idleDevice({
			audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, gain_db: -6 }],
		});
		render(MixerOnStore);
		expect(
			screen.getByTestId(`audio-strip-gain-value-${MAIN}`).textContent?.trim(),
		).toBe("-6 dB");

		await fireEvent.click(screen.getByTestId(`audio-strip-gain-reset-${MAIN}`));
		expectMixCleared(await device.answer(await held.next("setAudioMix")));

		expect(held.calls[0]?.input).toEqual({ id: MAIN, gain_db: 0 });
		expect(
			screen.getByTestId(`audio-strip-gain-value-${MAIN}`).textContent?.trim(),
		).toBe("0 dB");
	});
});

/** The capture device the Encoder dialog reads its offers from. */
async function encoderDevice(config: Record<string, unknown>): Promise<void> {
	ingest("capabilities", {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "2160p",
		},
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min: 500, max: 50000, unit: "kbps" },
			default_codec: "h265",
		},
		sources: [],
	});
	ingest("sources", {
		hardware: "rk3588",
		sources: [
			{
				id: "cam-h265",
				origin: "capture",
				pipelineId: "libuvch265",
				kind: "uvc_h265",
				displayName: "H.265 Cam",
				devicePath: "/dev/video2",
				modes: [
					{
						width: 1920,
						height: 1080,
						framerates: [30],
						media_type: "video/x-h265",
					},
				],
				supportsAudio: true,
				supportsResolutionOverride: true,
				supportsFramerateOverride: true,
				defaultResolution: "1080p",
				defaultFramerate: 30,
				audioKind: "selectable",
				available: true,
			},
		],
	});
	await device.become({
		source: "cam-h265",
		pipeline: "libuvch265",
		...config,
	});
}

const q = (testid: string) =>
	document.body.querySelector(`[data-testid="${testid}"]`);

function openEncoder(onSave?: (config: EncoderConfig) => void) {
	vi.stubGlobal(
		"VideoDecoder",
		class {
			state = "configured";
			configure(): void {}
			decode(): void {}
			close(): void {}
		},
	);
	const view = render(EncoderDialog, {
		props: {
			open: true,
			config: {
				resolution: "1080p",
				framerate: 30,
				bitrate: 6000,
				bitrateOverlay: false,
			},
			onSave,
		},
	});
	flushSync();
	return view;
}

/** LiveView's encoder save, field locks included: lock, send, release. */
async function liveViewSave(saved: EncoderConfig): Promise<void> {
	const input = buildEncoderSetConfig(saved, undefined);
	const fields = Object.entries(input).filter(
		([field]) => field !== "apply_now",
	);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await (held.streaming.setConfig as (input: unknown) => Promise<unknown>)(
			input,
		);
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}

describe("the Encoder dialog shows a cleared format as Automatic", () => {
	it("(5) Manual codec, then Automatic and Save, reopen: Automatic", async () => {
		await encoderDevice({ video_codec: "h264" });
		let saving: Promise<void> | undefined;
		const view = openEncoder((saved) => {
			saving = liveViewSave(saved);
		});
		expect(q("encoder-format-manual")?.getAttribute("aria-checked")).toBe(
			"true",
		);

		await fireEvent.click(q("encoder-format-manual") as HTMLElement);
		const save = [...document.body.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === m["dialogs.save"](),
		);
		await fireEvent.click(save as HTMLButtonElement);
		const call = await held.next("setConfig");
		expect(call.input).toEqual({ video_codec: null });
		expect(isPending("video_codec")).toBe(true);

		// The clear settles the lock it answers before the answer itself does.
		const frames = (await device.call(call.method, call.input)).frames;
		for (const frame of frames) ingestFrame(frame);
		expect(frames.map(kind)).toEqual(["config", "config_clear"]);
		expect(isPending("video_codec")).toBe(false);
		call.resolve({ success: true, applied: {} });
		await saving;

		await view.rerender({ open: false });
		await view.rerender({ open: true });
		flushSync();
		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
		expect(q("encoder-format-manual")?.getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(q("encoder-format-automatic")?.getAttribute("data-active")).toBe(
			"true",
		);
	});
});

describe("the store deletes exactly the keys the device names", () => {
	it("(6) a selected_video_input clear reaches the store as a deleted key", async () => {
		await device.become({
			source: "osmo",
			selected_video_input: "osmo",
			max_br: 6000,
		});
		expect(getConfig()?.selected_video_input).toBe("osmo");

		// A switch to a network source: the device has no capture input to keep.
		const { frames } = await device.call("setConfig", { source: "rtmp" });
		const [config, clear, ...rest] = frames as [string, string];
		ingestFrame(config);
		expect(getConfig()?.selected_video_input).toBe("osmo");
		ingestFrame(clear);

		expect(rest).toEqual([]);
		expect(Object.hasOwn(getConfig() ?? {}, "selected_video_input")).toBe(
			false,
		);
		expect(getConfig()).toMatchObject({ source: "rtmp", max_br: 6000 });
	});

	it("a later config echo cannot bring the cleared value back", async () => {
		await device.become({ video_codec: "h264", max_br: 6000 });

		const clear = await device.call("setConfig", { video_codec: null });
		const echo = await device.call("setConfig", { max_br: 7000 });
		for (const frame of [...clear.frames, ...echo.frames]) ingestFrame(frame);

		expect(echo.frames.map(kind)).toEqual(["config"]);
		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
		expect(getConfig()?.max_br).toBe(7000);
	});
});

describe("the reconnect safety hydrate applies getConfig as a snapshot", () => {
	it("a pulled config without the cleared key shows the Encoder Automatic, and a broadcast-only autostart survives", async () => {
		await encoderDevice({ video_codec: "h264", autostart: true });

		// The clear happens while this tab's socket is closed, so its frames are
		// not delivered. The safety hydrate reads `streaming.getConfig`, which never
		// returns `autostart`. Two real tabs: e2e/config-clear-two-tabs.spec.ts.
		await device.call("setConfig", { video_codec: null });
		ingestPulledConfig((await device.call("getConfig")).result);

		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
		expect(getConfig()?.autostart).toBe(true);
		openEncoder();
		expect(q("encoder-format-manual")?.getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(q("encoder-format-automatic")?.getAttribute("data-active")).toBe(
			"true",
		);
	});
});

describe("Start never re-sends a cleared setting", () => {
	it("a key the device cleared is absent from the start input", async () => {
		await device.become({
			source: "osmo",
			selected_video_input: "osmo",
			video_codec: "h264",
			max_br: 6000,
		});
		for (const input of [{ source: "rtmp" }, { video_codec: null }])
			for (const frame of (await device.call("setConfig", input)).frames)
				ingestFrame(frame);

		void startStreaming(() => getConfig());
		const start = await held.next("start");

		// What the socket carries: the request after the real JSON serializer.
		const input = JSON.parse(JSON.stringify(start.input));
		expect(input).toMatchObject({ source: "rtmp", max_br: 6000 });
		expect(input).not.toHaveProperty("selected_video_input");
		expect(input).not.toHaveProperty("video_codec");
		start.resolve({ success: true });
	});
});
