// @vitest-environment jsdom
/**
 * A cleared setting is sent as cleared and shown cleared (GAP-2).
 *
 * The device stores a cleared setting as absent, and JSON drops an absent key,
 * so a `config` frame cannot say "gone": the store keeps whatever it last held.
 * After every write that clears a key the device also sends
 * `config_clear { keys }`, and the store deletes exactly those keys. Each case
 * clicks like a person through the closed-loop harness: the real store, the
 * real serializer, the device's frames in the order it sends them (`config`,
 * then `config_clear`, then the reply).
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import {
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
import { type HeldCall, type HeldRpc, heldRpc, ingest } from "./device-loop";
import MixerOnStore from "./MixerOnStore.svelte";

const MAIN = "usb-a";
const SECOND = "usb-b";
const AT_DEFAULTS = { tracks: [1], gain_db: 0, mute: false, delay_ms: 0 };
const OK = { success: true, applies_next_start: true };

let held: HeldRpc;

beforeAll(() => {
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
});

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
function idleDevice(config: Record<string, unknown>): void {
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
	ingest("config", { asrc: MAIN, ...config });
}

/**
 * What the device does for a write that leaves the mix at its defaults: it
 * stores the mix as absent and broadcasts, then names the cleared key, then
 * answers the call.
 */
async function deviceClears(
	call: HeldCall,
	config: Record<string, unknown>,
	keys: string[],
	reply: unknown = OK,
): Promise<void> {
	ingest("config", config);
	ingest("config_clear", { keys });
	call.resolve(reply);
	await tick();
	flushSync();
}

describe("the mixer shows a cleared mix as cleared", () => {
	it("(1) idle unmute of a default primary: the button ends unmuted after the reply and the echo", async () => {
		idleDevice({ audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, mute: true }] });
		render(MixerOnStore);
		const mute = screen.getByTestId(`audio-strip-mute-${MAIN}`);
		expect(mute.getAttribute("aria-pressed")).toBe("true");

		await fireEvent.click(mute);
		const unmute = await held.next("setAudioMix");
		expect(unmute.input).toEqual({ id: MAIN, mute: false });
		await deviceClears(unmute, { asrc: MAIN, audio_inputs: undefined }, [
			"audio_inputs",
		]);

		expect(
			screen
				.getByTestId(`audio-strip-mute-${MAIN}`)
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(Object.hasOwn(getConfig() ?? {}, "audio_inputs")).toBe(false);
	});

	it("(2) primary on Tracks 1+2, remove Track 2: shows Track 1 only", async () => {
		idleDevice({
			audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, tracks: [1, 2] }],
		});
		render(MixerOnStore);
		expect(
			screen
				.getByTestId(`audio-strip-track-${MAIN}-2`)
				.getAttribute("aria-pressed"),
		).toBe("true");

		await fireEvent.click(screen.getByTestId(`audio-strip-track-${MAIN}-2`));
		await deviceClears(
			await held.next("setAudioMix"),
			{ asrc: MAIN, audio_inputs: undefined },
			["audio_inputs"],
		);

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
		idleDevice({});
		render(MixerOnStore);
		const enable = () => screen.getByTestId(`audio-strip-enable-${SECOND}`);
		expect(enable().getAttribute("aria-checked")).toBe("false");

		await fireEvent.click(enable());
		const include = await held.next("setAudioMix");
		expect(include.input).toEqual({ id: SECOND, include: true });
		ingest("config", {
			asrc: MAIN,
			audio_inputs: [
				{ id: MAIN, ...AT_DEFAULTS },
				{ id: SECOND, ...AT_DEFAULTS },
			],
		});
		include.resolve(OK);
		await tick();
		expect(enable().getAttribute("aria-checked")).toBe("true");

		await fireEvent.click(enable());
		await deviceClears(
			await held.next("setAudioMix"),
			{ asrc: MAIN, audio_inputs: undefined },
			["audio_inputs"],
		);

		expect(held.calls[1]?.input).toEqual({ id: SECOND, include: false });
		expect(enable().getAttribute("aria-checked")).toBe("false");
	});

	it("(4) primary at -6 dB, reset: shows 0 dB", async () => {
		idleDevice({ audio_inputs: [{ id: MAIN, ...AT_DEFAULTS, gain_db: -6 }] });
		render(MixerOnStore);
		expect(
			screen.getByTestId(`audio-strip-gain-value-${MAIN}`).textContent?.trim(),
		).toBe("-6 dB");

		await fireEvent.click(screen.getByTestId(`audio-strip-gain-reset-${MAIN}`));
		await deviceClears(
			await held.next("setAudioMix"),
			{ asrc: MAIN, audio_inputs: undefined },
			["audio_inputs"],
		);

		expect(held.calls[0]?.input).toEqual({ id: MAIN, gain_db: 0 });
		expect(
			screen.getByTestId(`audio-strip-gain-value-${MAIN}`).textContent?.trim(),
		).toBe("0 dB");
	});
});

/** The capture device the Encoder dialog reads its offers from. */
function encoderDevice(config: Record<string, unknown>): void {
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
	ingest("config", { source: "cam-h265", pipeline: "libuvch265", ...config });
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
		encoderDevice({ video_codec: "h264" });
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

		ingest("config", {
			source: "cam-h265",
			pipeline: "libuvch265",
			video_codec: undefined,
		});
		ingest("config_clear", { keys: ["video_codec"] });
		// The clear settles the lock it answers: nothing holds an old echo out.
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
	it("(6) a selected_video_input clear reaches the store as a deleted key", () => {
		ingest("config", {
			source: "cam-1",
			selected_video_input: "/dev/video0",
			max_br: 6000,
		});

		ingest("config", {
			source: "cam-1",
			selected_video_input: undefined,
			max_br: 6000,
		});
		expect(getConfig()?.selected_video_input).toBe("/dev/video0");
		ingest("config_clear", { keys: ["selected_video_input"] });

		expect(Object.hasOwn(getConfig() ?? {}, "selected_video_input")).toBe(
			false,
		);
		expect(getConfig()).toEqual({ source: "cam-1", max_br: 6000 });
	});

	it("a later config echo from the same write cannot bring the cleared value back", () => {
		ingest("config", { video_codec: "h264", resolution: "1080p" });

		ingest("config", { resolution: "1080p" });
		ingest("config_clear", { keys: ["video_codec"] });
		ingest("config", { resolution: "1080p", video_codec: undefined });

		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
	});

	it("an omitted key in a config frame still means unchanged", () => {
		ingest("config", { video_codec: "h264", resolution: "1080p" });

		ingest("config", { resolution: "720p" });

		expect(getConfig()).toEqual({ video_codec: "h264", resolution: "720p" });
	});

	it("a clear that crosses a newer pending choice deletes the stale value and keeps that choice's lock", () => {
		ingest("config", { video_codec: "h264" });
		markPending("video_codec", "h265");

		ingest("config_clear", { keys: ["video_codec"] });

		expect(Object.hasOwn(getConfig() ?? {}, "video_codec")).toBe(false);
		expect(isPending("video_codec")).toBe(true);
		ingest("config", { video_codec: "h265" });
		expect(getConfig()?.video_codec).toBe("h265");
		onRpcResolved("video_codec");
	});

	it("a malformed config_clear changes nothing", () => {
		ingest("config", { video_codec: "h264" });
		const before = getConfig();

		for (const payload of [
			undefined,
			null,
			{},
			{ keys: "video_codec" },
			{ keys: [1, null] },
		]) {
			ingest("config_clear", payload);
		}

		expect(getConfig()).toBe(before);
	});

	it("a message type this build does not know is ignored", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		ingest("config", { video_codec: "h264" });
		const before = getConfig();

		expect(() =>
			ingest("config_reset_v9", { keys: ["video_codec"] }),
		).not.toThrow();

		expect(getConfig()).toBe(before);
		warn.mockRestore();
	});
});

describe("the reconnect safety hydrate applies getConfig as a snapshot", () => {
	it("a pulled config without the cleared key shows the Encoder Automatic, and a broadcast-only autostart survives", () => {
		encoderDevice({ video_codec: "h264", autostart: true });

		// The clear happened while this tab's socket was closed, so it got no frames.
		// Its safety hydrate reads streaming.getConfig, which never returns autostart.
		// The two-tab path end to end is e2e/config-clear-two-tabs.spec.ts.
		ingestPulledConfig({ source: "cam-h265", pipeline: "libuvch265" });

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

	it("a key the snapshot omits keeps the local value while its field lock is pending", () => {
		ingest("config", { source: "cam-h265", max_br: 6000 });
		markPending("max_br", 8000);

		ingestPulledConfig({ source: "cam-h265" });

		expect(getConfig()?.max_br).toBe(6000);
		onRpcResolved("max_br");
	});
});

describe("Start never re-sends a cleared setting", () => {
	it("a key the device cleared is absent from the start input", async () => {
		ingest("config", {
			source: "cam-1",
			selected_video_input: "/dev/video0",
			video_codec: "h264",
			max_br: 6000,
		});
		ingest("config", { source: "cam-1", max_br: 6000 });
		ingest("config_clear", { keys: ["selected_video_input", "video_codec"] });

		void startStreaming(() => getConfig());
		const start = await held.next("start");

		// What the socket carries: the request after the real JSON serializer.
		expect(JSON.parse(JSON.stringify(start.input))).toStrictEqual({
			source: "cam-1",
			max_br: 6000,
		});
		start.resolve({ success: true });
	});
});
