// @vitest-environment jsdom
/**
 * EncoderDialog — the complete request each Save sends.
 *
 * A Save writes exactly the settings the operator changed in this session and
 * nothing else: an untouched Save sends an empty request, and each control sends
 * only its own key. Every case deep-equals the WHOLE request LiveView builds from
 * the dialog's draft (the same mapper, with a pipeline that allows overrides), so
 * an extra key anywhere fails the case.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	CaptureStreamSource,
	Pipeline,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { updateMaxBitrate } from "$lib/components/streaming/StreamingUtils";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import {
	reactiveConfig,
	reactiveSources,
} from "../../tests/fixtures/reactive-subscriptions.svelte";
import type { EncoderConfig } from "./EncoderDialog.svelte";
import EncoderDialog from "./EncoderDialog.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveConfig, reactiveSources } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getPipelines: () => ({ hardware: "rk3588", pipelines: {} }),
		getCapabilities: () => ({
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "2160p",
			},
			encoder: {
				codecs: ["H264", "H265"],
				default_codec: "h265",
				bitrate_range: { min: 500, max: 20000, unit: "kbps" },
			},
			sources: [],
		}),
		getDevices: () => undefined,
		getIsStreaming: () => false,
		getConfig: () => reactiveConfig.value,
		getSources: () => reactiveSources.value,
	};
});

vi.mock("$lib/components/streaming/StreamingUtils", () => ({
	normalizeValue: (value: number) => value,
	updateMaxBitrate: vi.fn(),
}));

vi.mock("$lib/rpc", () => ({
	rpc: {
		system: {
			mintPreviewToken: vi.fn(async () => ({ token: "tok-1", ttlMs: 30000 })),
		},
	},
}));

const CAMERA: CaptureStreamSource = {
	id: "cam-h265",
	origin: "capture",
	pipelineId: "libuvch265",
	kind: "uvc_h265",
	displayName: "H.265 Cam",
	devicePath: "/dev/video2",
	modes: [
		{ width: 1920, height: 1080, framerates: [30], media_type: "video/x-h265" },
		{ width: 1280, height: 720, framerates: [30], media_type: "video/x-h265" },
	],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// The pipeline LiveView hands the mapper for this camera: overrides allowed, so a
// resolution or framerate key can only be missing because nothing changed.
const PIPELINE: Pipeline = {
	name: "UVC H.265",
	description: "fixture",
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
};

// LiveView's draft before any save: every field undefined.
const FIRST_OPEN_DRAFT: EncoderConfig = {
	source: undefined,
	resolution: undefined,
	framerate: undefined,
	bitrate: undefined,
	bitrateOverlay: undefined,
};

const SAVED = {
	source: "cam-h265",
	pipeline: "libuvch265",
	resolution: "1080p",
	framerate: 30,
	max_br: 6000,
	bitrate_overlay: false,
};

function q(testid: string): HTMLElement {
	const el = document.body.querySelector<HTMLElement>(
		`[data-testid="${testid}"]`,
	);
	if (!el) throw new Error(`${testid} not rendered`);
	return el;
}

function saveButton(): HTMLButtonElement {
	const button = [...document.body.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === m["dialogs.save"](),
	);
	if (!button) throw new Error("save button not rendered");
	return button;
}

function mount(props: Record<string, unknown> = {}) {
	const onSave = vi.fn();
	render(EncoderDialog, {
		props: { open: true, config: { ...FIRST_OPEN_DRAFT }, onSave, ...props },
	});
	flushSync();
	return onSave;
}

async function saveRequest(onSave: ReturnType<typeof vi.fn>) {
	await fireEvent.click(saveButton());
	expect(onSave).toHaveBeenCalledTimes(1);
	return buildEncoderSetConfig(
		onSave.mock.calls[0][0] as EncoderConfig,
		PIPELINE,
	);
}

beforeAll(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
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
	reactiveConfig.reset();
	reactiveSources.reset();
	reactiveSources.value = {
		hardware: "rk3588",
		sources: [CAMERA],
	} as SourcesMessage;
	reactiveConfig.value = { ...SAVED } as never;
	vi.mocked(updateMaxBitrate).mockClear();
	vi.stubGlobal(
		"VideoDecoder",
		class {
			state = "configured";
			configure(): void {}
			decode(): void {}
			close(): void {}
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

vi.setConfig({ testTimeout: 15000 });

describe("EncoderDialog — Save sends exactly what the operator changed", () => {
	it("an untouched Save sends an empty request", async () => {
		const onSave = mount();
		expect(await saveRequest(onSave)).toEqual({});
		expect(updateMaxBitrate).not.toHaveBeenCalled();
	});

	it("flipping only the adaptive switch sends only the balancer", async () => {
		const onSave = mount();
		await fireEvent.click(q("encoder-adaptive"));
		expect(await saveRequest(onSave)).toEqual({ balancer: "fixed" });
	});

	it("turning on the format switch and picking H.264 sends only the codec", async () => {
		const onSave = mount();
		await fireEvent.click(q("encoder-format-manual"));
		await fireEvent.click(q("encoder-format-h264"));
		expect(await saveRequest(onSave)).toEqual({ video_codec: "h264" });
	});

	it("the legacy reset saves on its own, and a Save after it sends an empty request", async () => {
		reactiveConfig.value = { ...SAVED, video_passthrough: "force" } as never;
		const onResetPassthrough = vi.fn(async () => true);
		const onSave = mount({ onResetPassthrough });

		await fireEvent.click(q("encoder-legacy-passthrough-reset"));
		await Promise.resolve();
		flushSync();
		expect(onResetPassthrough).toHaveBeenCalledTimes(1);

		expect(await saveRequest(onSave)).toEqual({});
	});

	it("changing only the resolution sends only the resolution", async () => {
		const onSave = mount();
		const trigger = document.body.querySelector(
			"#encoder-resolution",
		) as HTMLElement;
		expect(trigger.textContent).toContain("1080p");

		await fireEvent.keyDown(trigger, { key: "ArrowDown" });
		const option = await screen.findByRole("option", { name: /720p/ });
		await fireEvent.pointerUp(option);
		await fireEvent.click(option);
		flushSync();
		expect(trigger.textContent).toContain("720p");

		expect(await saveRequest(onSave)).toEqual({ resolution: "720p" });
	});

	it("changing only the bitrate sends only the bitrate and applies it live", async () => {
		const onSave = mount();
		const input = document.body.querySelector(
			"#encoder-bitrate",
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "7000" } });
		expect(await saveRequest(onSave)).toEqual({ max_br: 7000 });
		expect(updateMaxBitrate).toHaveBeenCalledTimes(1);
	});

	it("turning only the bitrate overlay on sends only the overlay", async () => {
		const onSave = mount();
		const overlay = document.body.querySelector(
			'[aria-label="' + m["settings.enableBitrateOverlay"]() + '"]',
		) as HTMLElement;
		await fireEvent.click(overlay);
		expect(await saveRequest(onSave)).toEqual({ bitrate_overlay: true });
	});
});
