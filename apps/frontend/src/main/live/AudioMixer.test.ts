// @vitest-environment jsdom
/**
 * AudioMixer — one strip per audio input in the Audio card (Live screen
 * contract, change 4).
 *
 *   • without the engine's `audio_mix` capability nothing renders;
 *   • idle, every change saves `setConfig({ audio_inputs })` with every enabled
 *     strip, and `null` once only the main input is left at its defaults;
 *   • live on a mix session, level, mute and delay go to `setAudioMix` (never
 *     `setConfig`), the level at most every 100 ms while dragging and once on
 *     release, while the enable switches and track chips wait for the next start;
 *   • live on a session started without the mix, every control waits;
 *   • every refusal the UI shows is the copy of one backend token, whether the
 *     backend sent it or the UI caught the same rule first;
 *   • every bound comes from the capability: gain, delay, tracks and inputs.
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	SetAudioMixOutput,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);
const setAudioMix = vi.hoisted(() =>
	vi.fn<(input: Record<string, unknown>) => Promise<SetAudioMixOutput>>(),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig, setAudioMix } },
	rpcClient: {},
}));

// The socket-fed getters, set per test before rendering.
const feed = vi.hoisted(() => ({
	status: undefined as Record<string, unknown> | undefined,
	level: undefined as Record<string, unknown> | undefined,
	sources: undefined as Record<string, unknown> | undefined,
	connected: true,
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStatus: () => feed.status,
	getAudioLevel: () => feed.level,
	getSources: () => feed.sources,
	getConfig: () => undefined,
	getIsConnected: () => feed.connected,
}));

import AudioMixer from "./AudioMixer.svelte";

beforeAll(() => {
	// bits-ui's Slider installs a ResizeObserver, absent in jsdom.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setConfig.mockReset();
	setAudioMix.mockReset();
	feed.status = undefined;
	feed.level = undefined;
	feed.sources = undefined;
	feed.connected = true;
});

const MIX = {
	max_inputs: 4,
	max_tracks: 4,
	gain_db_min: -60,
	gain_db_max: 12,
	delay_ms_max: 2000,
};

function caps(mix: Partial<typeof MIX> = {}): CapabilitiesMessage {
	return { audio_mix: { ...MIX, ...mix } } as unknown as CapabilitiesMessage;
}

// Three selectable devices (caps-full has three), a pseudo-source and one row
// the engine cannot open: only the three devices get a strip.
const AUDIO_SOURCES = [
	{ id: "usb-a", kind: "device", label: "RODE AI-Micro" },
	{ id: "usb-b", kind: "device", label: "Elgato Wave:3" },
	{ id: "hdmi", kind: "device", label: "HDMI Input" },
	{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
	{
		id: "old-mic",
		kind: "device",
		label: "Old mic",
		unavailable_reason: "engine_update_required",
	},
];

const DEFAULTS = { tracks: [1], gain_db: 0, mute: false, delay_ms: 0 };

type Input = {
	id: string;
	tracks: number[];
	gain_db: number;
	mute: boolean;
	delay_ms: number;
};

function input(id: string, fields: Partial<Input> = {}): Input {
	return { id, ...DEFAULTS, ...fields };
}

const SAVED_OK: StreamingSetConfigOutput = { success: true, applied: {} };

function mixer(
	options: {
		config?: Record<string, unknown>;
		capabilities?: CapabilitiesMessage | undefined;
		isStreaming?: boolean;
		mixActive?: boolean;
		status?: Record<string, unknown>;
	} = {},
) {
	const {
		config = { asrc: "usb-a", pipeline: "hdmi" },
		isStreaming = false,
		mixActive = false,
		status = {},
	} = options;
	// An explicit `capabilities: undefined` is a case of its own, not the default.
	const capabilities =
		"capabilities" in options ? options.capabilities : caps();
	feed.status = {
		audio_sources: AUDIO_SOURCES,
		asrcs: AUDIO_SOURCES.map((source) => source.id),
		audio_mix_active: mixActive,
		...status,
	};
	return render(AudioMixer, {
		props: {
			config: config as unknown as ConfigMessage,
			capabilities,
			isStreaming,
		},
	});
}

const strip = (id: string) => screen.getByTestId(`audio-strip-${id}`);
const enable = (id: string) => screen.getByTestId(`audio-strip-enable-${id}`);
const mute = (id: string) => screen.getByTestId(`audio-strip-mute-${id}`);
const delay = (id: string) =>
	screen.getByTestId(`audio-strip-delay-${id}`) as HTMLInputElement;
const chip = (id: string, n: number) =>
	screen.getByTestId(`audio-strip-track-${id}-${n}`);
const gainRoot = (id: string) => screen.getByTestId(`audio-strip-gain-${id}`);
const gainThumb = (id: string) => within(gainRoot(id)).getByRole("slider");
const errorOf = (id: string) => screen.getByTestId(`audio-strip-error-${id}`);
const reasonOf = (id: string) => screen.getByTestId(`audio-strip-reason-${id}`);

function stripIds(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-audio-strip]"),
	).map((el) => el.dataset.audioStrip ?? "");
}

function expectDisabled(el: HTMLElement): void {
	expect(
		el.hasAttribute("disabled") || el.hasAttribute("data-disabled"),
		`${el.dataset.testid} is disabled`,
	).toBe(true);
}

function expectEnabled(el: HTMLElement): void {
	expect(
		el.hasAttribute("disabled") || el.hasAttribute("data-disabled"),
		`${el.dataset.testid} is enabled`,
	).toBe(false);
}

const NEXT_START = "Applies on next start";
const GAP =
	"Use tracks in order from Track 1, with no gaps. Track 1 always needs an input.";

describe("AudioMixer — capability gate", () => {
	it("renders no strip and no mixer node without the audio_mix capability", () => {
		mixer({ capabilities: {} as CapabilitiesMessage });
		expect(screen.queryByTestId("audio-mixer")).toBeNull();
		expect(stripIds()).toEqual([]);
	});

	it("renders nothing for an undefined capabilities snapshot", () => {
		mixer({ capabilities: undefined });
		expect(screen.queryByTestId("audio-mixer")).toBeNull();
	});

	it("renders one strip per selectable audio device, never a pseudo-source or an unopenable one", () => {
		mixer();
		expect(stripIds()).toEqual(["usb-a", "usb-b", "hdmi"]);
		expect(within(strip("usb-b")).getByText("Elgato Wave:3")).toBeTruthy();
		expect(screen.getByTestId("audio-mixer-track-hint").textContent).toContain(
			"Most receivers play only Track 1.",
		);
	});
});

describe("AudioMixer — idle", () => {
	it("with nothing saved, the main strip is on at level 0, unmuted, delay 0, Track 1 only", () => {
		mixer();
		expect(enable("usb-a").getAttribute("aria-checked")).toBe("true");
		expect(gainThumb("usb-a").getAttribute("aria-valuenow")).toBe("0");
		expect(mute("usb-a").getAttribute("aria-pressed")).toBe("false");
		expect(delay("usb-a").value).toBe("0");
		expect(chip("usb-a", 1).getAttribute("aria-pressed")).toBe("true");
		for (const n of [2, 3, 4]) {
			expect(chip("usb-a", n).getAttribute("aria-pressed")).toBe("false");
		}
		// The others are off and carry no level, mute, delay or track controls.
		expect(enable("usb-b").getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByTestId("audio-strip-gain-usb-b")).toBeNull();
		expect(screen.queryByTestId("audio-strip-track-usb-b-1")).toBeNull();
	});

	it("the main strip shows today's meter; the others say their level shows once live", () => {
		mixer();
		expect(within(strip("usb-a")).getByTestId("live-audio-meter")).toBeTruthy();
		expect(within(strip("usb-b")).queryByTestId("live-audio-meter")).toBeNull();
		expect(
			within(strip("usb-b")).getByText("Level shows once you go live"),
		).toBeTruthy();
	});

	it("the main strip cannot be turned off: its switch is disabled with the reason beside it", async () => {
		mixer();
		expectDisabled(enable("usb-a"));
		expect(reasonOf("usb-a").textContent).toContain("Main input");
		expect(enable("usb-a").getAttribute("aria-describedby")).toContain(
			reasonOf("usb-a").id,
		);
		await fireEvent.click(enable("usb-a"));
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("enabling a second input saves both, main input first, each on Track 1", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer();
		await fireEvent.click(enable("usb-b"));
		expect(setConfig).toHaveBeenCalledTimes(1);
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("usb-a"), input("usb-b")],
		});
	});

	it("keeps the saved values of every enabled strip when another one changes", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [
					input("usb-a", { gain_db: -6 }),
					input("usb-b", { tracks: [1, 2], delay_ms: 120 }),
				],
			},
		});
		await fireEvent.click(mute("usb-b"));
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [
				input("usb-a", { gain_db: -6 }),
				input("usb-b", { tracks: [1, 2], delay_ms: 120, mute: true }),
			],
		});
	});

	it("returning the only enabled strip to its defaults saves audio_inputs: null", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [input("usb-a", { gain_db: -6 })],
			},
		});
		await fireEvent.click(screen.getByTestId("audio-strip-gain-reset-usb-a"));
		expect(setConfig).toHaveBeenCalledWith({ audio_inputs: null });
	});

	it("turning off the last other input saves audio_inputs: null", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		await fireEvent.click(enable("usb-b"));
		expect(setConfig).toHaveBeenCalledWith({ audio_inputs: null });
	});

	it("a level change is saved once, on release, with the new level", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer();
		await fireEvent.keyDown(gainThumb("usb-a"), { key: "ArrowLeft" });
		expect(setConfig).toHaveBeenCalledTimes(1);
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("usb-a", { gain_db: -1 })],
		});
	});

	it("turning off the only chip on Track 1 is refused with the reason, and nothing is saved", async () => {
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [
					input("usb-a", { tracks: [1, 2] }),
					input("usb-b", { tracks: [2] }),
				],
			},
		});
		await fireEvent.click(chip("usb-a", 1));
		expect(setConfig).not.toHaveBeenCalled();
		expect(chip("usb-a", 1).getAttribute("aria-pressed")).toBe("true");
		expect(errorOf("usb-a").textContent).toContain(GAP);
		expect(errorOf("usb-a").getAttribute("role")).toBe("alert");
	});

	it("turning on a chip past an unused track is refused as a gap", async () => {
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		await fireEvent.click(chip("usb-b", 3));
		expect(setConfig).not.toHaveBeenCalled();
		expect(errorOf("usb-b").textContent).toContain(GAP);
	});

	it("turning off an input's last chip is refused: every input needs a track", async () => {
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [input("usb-a"), input("usb-b", { tracks: [1] })],
			},
		});
		await fireEvent.click(chip("usb-b", 1));
		expect(setConfig).not.toHaveBeenCalled();
		expect(errorOf("usb-b").textContent).toContain(
			"Every input needs at least one track.",
		);
	});

	it("putting a second input on Track 2 is saved", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		await fireEvent.click(chip("usb-b", 2));
		await fireEvent.click(chip("usb-b", 1));
		expect(setConfig).toHaveBeenNthCalledWith(1, {
			audio_inputs: [input("usb-a"), input("usb-b", { tracks: [1, 2] })],
		});
	});

	it("a save the backend refuses shows its reason beside the strip and leaves the chips as they were", async () => {
		let answer: (value: StreamingSetConfigOutput) => void = () => undefined;
		setConfig.mockReturnValue(
			new Promise<StreamingSetConfigOutput>((resolve) => {
				answer = resolve;
			}),
		);
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		await fireEvent.click(chip("usb-b", 2));
		// While the device works on it, the tapped chip shows as the choice.
		await waitFor(() =>
			expect(chip("usb-b", 2).getAttribute("aria-pressed")).toBe("true"),
		);
		answer({ success: false, error: "audio_tracks_gap", applied: {} });
		await waitFor(() =>
			expect(chip("usb-b", 2).getAttribute("aria-pressed")).toBe("false"),
		);
		expect(errorOf("usb-b").textContent).toContain(GAP);
		expect(errorOf("usb-a").textContent).toBe("");
	});

	it.each([
		["audio_mix_unsupported", "This device can't mix audio inputs."],
		[
			"audio_input_unknown",
			"This input isn't available any more. Reconnect it or turn it off.",
		],
		["audio_inputs_empty", "Keep at least one input in the mix."],
		[
			"audio_input_duplicate",
			"This input is in the mix twice. Turn it off, then on again.",
		],
		["audio_inputs_too_many", "The mix is full. Turn another input off first."],
		["audio_tracks_invalid", "Every input needs at least one track."],
		["audio_tracks_gap", GAP],
		["audio_gain_range", "Gain must be between -60 and 12 dB."],
		["audio_delay_range", "Delay must be a whole number from 0 to 2000 ms."],
		[
			"cerastream.params.invalid",
			"The device refused this change, so nothing changed.",
		],
	])(
		"a refused save with %s shows its copy, never the raw token",
		async (token, copy) => {
			setConfig.mockResolvedValue({
				success: false,
				error: token,
				applied: {},
			});
			mixer();
			await fireEvent.click(enable("usb-b"));
			await waitFor(() => expect(errorOf("usb-b").textContent).toContain(copy));
			expect(errorOf("usb-b").textContent).not.toContain(token);
		},
	);

	it("a save that throws says it failed", async () => {
		setConfig.mockRejectedValue(new Error("socket closed"));
		mixer();
		await fireEvent.click(enable("usb-b"));
		await waitFor(() => expect(errorOf("usb-b").textContent).not.toBe(""));
	});
});

describe("AudioMixer — which input is the main one", () => {
	it("Auto follows the input the device resolved, and saves it first", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: { asrc: "Auto", pipeline: "hdmi" },
			status: { resolved_asrc: "usb-b" },
		});
		expectDisabled(enable("usb-b"));
		expect(enable("usb-b").getAttribute("aria-checked")).toBe("true");
		expectEnabled(enable("usb-a"));
		await fireEvent.click(enable("usb-a"));
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("usb-b"), input("usb-a")],
		});
	});

	it("the main input is saved first even when its strip is not the first one", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: {
				asrc: "Auto",
				pipeline: "hdmi",
				audio_inputs: [input("usb-b"), input("usb-a")],
			},
			status: { resolved_asrc: "usb-b" },
		});
		await fireEvent.click(mute("usb-a"));
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("usb-b"), input("usb-a", { mute: true })],
		});
	});

	it("a network source's embedded audio is the main strip and is saved under the source id", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		feed.sources = {
			hardware: "rk3588",
			sources: [
				{
					origin: "network",
					id: "rtmp",
					pipelineId: "rtmp",
					labelKey: "settings.sources.rtmp",
					requiresGateway: "rtmp",
					modes: [],
					supportsAudio: true,
					supportsResolutionOverride: false,
					supportsFramerateOverride: false,
					audioKind: "embedded",
					available: true,
				},
			],
		};
		mixer({
			config: { asrc: "Auto", pipeline: "rtmp", source: "rtmp" },
			capabilities: {
				audio_mix: MIX,
				network_embedded_audio: true,
			} as unknown as CapabilitiesMessage,
		});
		expect(stripIds()).toEqual(["rtmp", "usb-a", "usb-b", "hdmi"]);
		expectDisabled(enable("rtmp"));
		await fireEvent.click(enable("usb-a"));
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("rtmp"), input("usb-a")],
		});
	});

	it("without a main input, no other input can be turned on and the reason is shown", async () => {
		mixer({ config: { asrc: "No audio", pipeline: "hdmi" } });
		for (const id of ["usb-a", "usb-b", "hdmi"]) {
			expectDisabled(enable(id));
			expect(reasonOf(id).textContent).toContain(
				"Pick an audio source above to mix other inputs with it.",
			);
		}
		// Today's meter is still on screen, above the strips.
		expect(screen.getByTestId("live-audio-meter")).toBeTruthy();
		await fireEvent.click(enable("usb-b"));
		expect(setConfig).not.toHaveBeenCalled();
	});
});

describe("AudioMixer — live on a mix session", () => {
	const LIVE_CONFIG = {
		asrc: "usb-a",
		audio_inputs: [input("usb-a"), input("usb-b", { tracks: [2] })],
	};

	function applied(id: string, fields: Partial<Input> = {}): SetAudioMixOutput {
		return {
			success: true,
			applied: { id, gain_db: 0, mute: false, delay_ms: 0, ...fields },
			applies_next_start: false,
		};
	}

	it("a level change calls setAudioMix and never setConfig", async () => {
		setAudioMix.mockResolvedValue(applied("usb-b", { gain_db: -1 }));
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
		await fireEvent.keyDown(gainThumb("usb-b"), { key: "ArrowLeft" });
		expect(setAudioMix).toHaveBeenCalledTimes(1);
		expect(setAudioMix).toHaveBeenCalledWith({ id: "usb-b", gain_db: -1 });
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("mute and delay go to setAudioMix with only the changed field", async () => {
		setAudioMix.mockResolvedValue(applied("usb-b"));
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
		await fireEvent.click(mute("usb-b"));
		await fireEvent.change(delay("usb-b"), { target: { value: "250" } });
		expect(setAudioMix.mock.calls.map(([call]) => call)).toEqual([
			{ id: "usb-b", mute: true },
			{ id: "usb-b", delay_ms: 250 },
		]);
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("the level readout keeps its sign before the number in right-to-left locales", () => {
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [input("usb-a", { gain_db: -6 })],
			},
		});
		const value = screen.getByTestId("audio-strip-gain-value-usb-a");
		expect(value.getAttribute("dir")).toBe("ltr");
		expect(value.textContent?.trim()).toBe("-6 dB");
	});

	it("shows the values the device applied, which win over what was asked", async () => {
		setAudioMix.mockResolvedValue(applied("usb-b", { gain_db: -3 }));
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
		await fireEvent.keyDown(gainThumb("usb-b"), { key: "ArrowLeft" });
		await waitFor(() =>
			expect(gainThumb("usb-b").getAttribute("aria-valuenow")).toBe("-3"),
		);
	});

	it("while dragging the level is sent at most every 100 ms, and once more on release", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		setAudioMix.mockResolvedValue(applied("usb-b"));
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });

		// 72 px across -60..12 dB: one pixel per dB, clientX = gain + 60.
		const track = gainRoot("usb-b");
		track.getBoundingClientRect = () =>
			({
				left: 0,
				right: 72,
				top: 0,
				bottom: 10,
				width: 72,
				height: 10,
				x: 0,
				y: 0,
			}) as DOMRect;

		await fireEvent.pointerDown(track, { button: 0, clientX: 50 });
		expect(setAudioMix.mock.calls.map(([call]) => call)).toEqual([
			{ id: "usb-b", gain_db: -10 },
		]);

		await fireEvent.pointerMove(document, { clientX: 40 });
		await fireEvent.pointerMove(document, { clientX: 30 });
		vi.advanceTimersByTime(99);
		expect(setAudioMix).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		expect(setAudioMix).toHaveBeenCalledTimes(2);
		expect(setAudioMix).toHaveBeenLastCalledWith({ id: "usb-b", gain_db: -30 });

		await fireEvent.pointerMove(document, { clientX: 25 });
		await fireEvent.pointerUp(document);
		expect(setAudioMix).toHaveBeenCalledTimes(3);
		expect(setAudioMix).toHaveBeenLastCalledWith({ id: "usb-b", gain_db: -35 });

		// The release cancelled the pending send: nothing trails it.
		vi.advanceTimersByTime(500);
		expect(setAudioMix).toHaveBeenCalledTimes(3);
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("track chips and enable switches wait for the next start, with the next-start text", () => {
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
		const note = screen.getByTestId("audio-mixer-next-start");
		expect(note.textContent).toContain(NEXT_START);
		for (const id of ["usb-a", "usb-b", "hdmi"]) {
			expectDisabled(enable(id));
		}
		for (const n of [1, 2, 3, 4]) {
			expectDisabled(chip("usb-a", n));
			expectDisabled(chip("usb-b", n));
			expect(chip("usb-b", n).getAttribute("aria-describedby")).toContain(
				note.id,
			);
		}
		expectEnabled(gainRoot("usb-b"));
		expectEnabled(mute("usb-b"));
		expectEnabled(delay("usb-b"));
	});

	it("each input in the mix shows its own level; a muted input reads silent", () => {
		feed.level = {
			inputs: [
				{
					input_id: "usb-a",
					channels: 2,
					rms_db: [-1e6, -1e6],
					peak_db: [-1e6, -1e6],
				},
				{
					input_id: "usb-b",
					channels: 2,
					rms_db: [-20, -22],
					peak_db: [-10, -12],
				},
			],
		};
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [
					input("usb-a", { mute: true }),
					input("usb-b", { tracks: [2] }),
				],
			},
			isStreaming: true,
			mixActive: true,
		});
		const meterA = within(strip("usb-a")).getByTestId("audio-level-meter");
		const meterB = within(strip("usb-b")).getByTestId("audio-level-meter");
		expect(meterB.dataset.silent).toBe("false");
		expect(meterB.dataset.channels).toBe("2");
		expect(meterA.dataset.silent).toBe("true");
		expect(meterA.dataset.unavailable).toBe("false");
		expect(mute("usb-a").getAttribute("aria-pressed")).toBe("true");
		// Today's meter belongs to the summary while live, not to a strip.
		expect(screen.queryByTestId("live-audio-meter")).toBeNull();
		// An input outside the running mix has no meter.
		expect(within(strip("hdmi")).queryByTestId("audio-level-meter")).toBeNull();
	});

	it("an input with no reading, or a dropped connection, reads unavailable instead of stale bars", () => {
		feed.level = {
			inputs: [
				{
					input_id: "usb-b",
					channels: 2,
					rms_db: [-20, -22],
					peak_db: [-10, -12],
				},
			],
		};
		feed.connected = false;
		mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
		for (const id of ["usb-a", "usb-b"]) {
			expect(
				within(strip(id)).getByTestId("audio-level-meter").dataset.unavailable,
			).toBe("true");
		}
	});

	it.each([
		["audio_gain_range", "Gain must be between -60 and 12 dB."],
		[
			"audio_input_unknown",
			"This input isn't available any more. Reconnect it or turn it off.",
		],
		[
			"cerastream.audio.device_not_found",
			"The device refused this change, so nothing changed.",
		],
		[
			"cerastream.params.invalid",
			"The device refused this change, so nothing changed.",
		],
	])(
		"a refused live change with %s shows its copy beside the strip",
		async (token, copy) => {
			setAudioMix.mockResolvedValue({ success: false, error: token });
			mixer({ config: LIVE_CONFIG, isStreaming: true, mixActive: true });
			await fireEvent.click(mute("usb-b"));
			await waitFor(() => expect(errorOf("usb-b").textContent).toContain(copy));
			expect(errorOf("usb-b").textContent).not.toContain(token);
			// The refused mute is not shown as applied.
			expect(mute("usb-b").getAttribute("aria-pressed")).toBe("false");
		},
	);
});

describe("AudioMixer — live on a session started without the mix", () => {
	it("every strip control is disabled with the next-start text, and nothing is sent", async () => {
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
			isStreaming: true,
			mixActive: false,
		});
		expect(screen.getByTestId("audio-mixer-next-start").textContent).toContain(
			NEXT_START,
		);
		for (const id of ["usb-a", "usb-b"]) {
			expectDisabled(enable(id));
			expectDisabled(gainRoot(id));
			expectDisabled(mute(id));
			expectDisabled(delay(id));
			expectDisabled(screen.getByTestId(`audio-strip-gain-reset-${id}`));
			for (const n of [1, 2, 3, 4]) expectDisabled(chip(id, n));
		}
		expectDisabled(enable("hdmi"));
		await fireEvent.click(mute("usb-b"));
		expect(setAudioMix).not.toHaveBeenCalled();
		expect(setConfig).not.toHaveBeenCalled();
	});
});

describe("AudioMixer — every bound comes from the capability", () => {
	it.each([
		[{}, "-60", "12"],
		[{ gain_db_min: -30, gain_db_max: 6 }, "-30", "6"],
	])(
		"the level slider runs from the minimum to the maximum (%o)",
		(mix, min, max) => {
			mixer({ capabilities: caps(mix) });
			expect(gainThumb("usb-a").getAttribute("aria-valuemin")).toBe(min);
			expect(gainThumb("usb-a").getAttribute("aria-valuemax")).toBe(max);
		},
	);

	it("idle, the level reaches both ends of the range and no further", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer();
		await fireEvent.keyDown(gainThumb("usb-a"), { key: "End" });
		await fireEvent.keyDown(gainThumb("usb-a"), { key: "Home" });
		expect(setConfig.mock.calls.map(([call]) => call)).toEqual([
			{ audio_inputs: [input("usb-a", { gain_db: 12 })] },
			{ audio_inputs: [input("usb-a", { gain_db: -60 })] },
		]);
	});

	it("live, the level reaches both ends of the range and no further", async () => {
		setAudioMix.mockResolvedValue({ success: true, applies_next_start: false });
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
			isStreaming: true,
			mixActive: true,
		});
		await fireEvent.keyDown(gainThumb("usb-b"), { key: "End" });
		await fireEvent.keyDown(gainThumb("usb-b"), { key: "Home" });
		expect(setAudioMix.mock.calls.map(([call]) => call)).toEqual([
			{ id: "usb-b", gain_db: 12 },
			{ id: "usb-b", gain_db: -60 },
		]);
	});

	it("the delay field declares 0 to the maximum in steps of 10", () => {
		mixer({ capabilities: caps({ delay_ms_max: 1500 }) });
		expect(delay("usb-a").getAttribute("min")).toBe("0");
		expect(delay("usb-a").getAttribute("max")).toBe("1500");
		expect(delay("usb-a").getAttribute("step")).toBe("10");
	});

	it.each([
		["2000", true],
		["2001", false],
		["0", true],
		["-1", false],
		["12.5", false],
	])("idle, a delay of %s ms is saved: %s", async (value, accepted) => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [input("usb-a", { delay_ms: 100 }), input("usb-b")],
			},
		});
		await fireEvent.change(delay("usb-a"), { target: { value } });
		if (accepted) {
			expect(setConfig).toHaveBeenCalledWith({
				audio_inputs: [
					input("usb-a", { delay_ms: Number(value) }),
					input("usb-b"),
				],
			});
			expect(errorOf("usb-a").textContent).toBe("");
		} else {
			expect(setConfig).not.toHaveBeenCalled();
			expect(errorOf("usb-a").textContent).toContain(
				"Delay must be a whole number from 0 to 2000 ms.",
			);
			// The field goes back to the value in effect.
			expect(delay("usb-a").value).toBe("100");
		}
	});

	it.each([
		["2000", true],
		["2001", false],
		["0", true],
		["-1", false],
	])("live, a delay of %s ms is sent: %s", async (value, accepted) => {
		setAudioMix.mockResolvedValue({ success: true, applies_next_start: false });
		mixer({
			config: {
				asrc: "usb-a",
				audio_inputs: [input("usb-a"), input("usb-b", { delay_ms: 100 })],
			},
			isStreaming: true,
			mixActive: true,
		});
		await fireEvent.change(delay("usb-b"), { target: { value } });
		if (accepted) {
			expect(setAudioMix).toHaveBeenCalledWith({
				id: "usb-b",
				delay_ms: Number(value),
			});
		} else {
			expect(setAudioMix).not.toHaveBeenCalled();
			expect(errorOf("usb-b").textContent).toContain(
				"Delay must be a whole number from 0 to 2000 ms.",
			);
		}
	});

	it.each([
		[4, false],
		[2, false],
		[4, true],
		[2, true],
	])(
		"there is one chip per track up to max_tracks=%i (live: %s)",
		(maxTracks, live) => {
			mixer({
				capabilities: caps({ max_tracks: maxTracks }),
				config: {
					asrc: "usb-a",
					audio_inputs: [input("usb-a"), input("usb-b")],
				},
				isStreaming: live,
				mixActive: live,
			});
			for (let n = 1; n <= maxTracks; n++) {
				expect(chip("usb-b", n).getAttribute("aria-label")).toContain(
					`Track ${n}`,
				);
			}
			expect(
				screen.queryByTestId(`audio-strip-track-usb-b-${maxTracks + 1}`),
			).toBeNull();
			expect(screen.queryByTestId("audio-strip-track-usb-b-0")).toBeNull();
		},
	);

	it("at max_inputs enabled strips, another input cannot be turned on and says why", async () => {
		mixer({
			capabilities: caps({ max_inputs: 2 }),
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		expectDisabled(enable("hdmi"));
		expect(reasonOf("hdmi").textContent).toContain(
			"The mix is full. Turn another input off first.",
		);
		await fireEvent.click(enable("hdmi"));
		expect(setConfig).not.toHaveBeenCalled();
		// Turning one off is still allowed.
		expectEnabled(enable("usb-b"));
	});

	it("one below max_inputs, another input can still be turned on", async () => {
		setConfig.mockResolvedValue(SAVED_OK);
		mixer({
			capabilities: caps({ max_inputs: 3 }),
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		expectEnabled(enable("hdmi"));
		await fireEvent.click(enable("hdmi"));
		expect(setConfig).toHaveBeenCalledWith({
			audio_inputs: [input("usb-a"), input("usb-b"), input("hdmi")],
		});
	});

	it("live, the switches stay disabled even below max_inputs", () => {
		mixer({
			capabilities: caps({ max_inputs: 4 }),
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
			isStreaming: true,
			mixActive: true,
		});
		expectDisabled(enable("hdmi"));
	});
});

describe("AudioMixer — accessible names", () => {
	it("every switch, slider, button, field and chip carries a name that includes its input", () => {
		mixer({
			config: { asrc: "usb-a", audio_inputs: [input("usb-a"), input("usb-b")] },
		});
		expect(enable("usb-b").getAttribute("aria-label")).toBe(
			"Include Elgato Wave:3 in the mix",
		);
		expect(gainThumb("usb-b").getAttribute("aria-label")).toBe(
			"Gain for Elgato Wave:3",
		);
		expect(mute("usb-b").getAttribute("aria-label")).toBe("Mute Elgato Wave:3");
		expect(
			screen
				.getByTestId("audio-strip-gain-reset-usb-b")
				.getAttribute("aria-label"),
		).toBe("Reset gain for Elgato Wave:3 to 0 dB");
		expect(
			screen.getByLabelText("Delay for Elgato Wave:3 in milliseconds"),
		).toBe(delay("usb-b"));
		expect(chip("usb-b", 2).getAttribute("aria-label")).toBe("Track 2");
		expect(
			screen.getByRole("group", { name: "Tracks for Elgato Wave:3" }),
		).toBeTruthy();
	});
});
