// @vitest-environment jsdom
/**
 * EncoderDialog — a saved Passthrough choice after the selector is gone.
 *
 * The Passthrough radios are replaced by the adaptive switch and the route line;
 * a saved `video_passthrough` keeps working exactly as before and is shown as a
 * notice with a one-tap reset:
 *  - force + a passthrough-capable source (uvc_h264 + h264 out) → the untouched
 *    route, bitrate slider + input disabled, the "Bitrate set by camera" reason
 *    visible, and the force notice.
 *  - force + an MJPEG source → the forceUnavailable route (start would fail
 *    typed), bitrate enabled, and the force notice.
 *  - auto → the adaptive switch on, the same-format route, no notice.
 */
import type { CaptureStreamSource, SourcesMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
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
				bitrate_range: { min: 500, max: 50000, unit: "kbps" },
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

const UVC_H264: CaptureStreamSource = {
	id: "uvc-0",
	origin: "capture",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "UVC H.264 Cam",
	devicePath: "/dev/video1",
	modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

const MJPEG: CaptureStreamSource = {
	...UVC_H264,
	id: "rode-0",
	kind: "mjpeg",
	displayName: "RØDE MJPEG",
};

function sourcesMessage(sources: SourcesMessage["sources"]): SourcesMessage {
	return { hardware: "rk3588", sources } as SourcesMessage;
}

function encoderConfig(partial: Partial<EncoderConfig> = {}): EncoderConfig {
	return {
		resolution: "1080p",
		framerate: 30,
		bitrate: 6000,
		bitrateOverlay: false,
		...partial,
	};
}

function q(testid: string): HTMLElement | null {
	return document.body.querySelector(`[data-testid="${testid}"]`);
}

function expectNoPassthroughSelector(): void {
	for (const id of [
		"encoder-passthrough-selector",
		"passthrough-auto",
		"passthrough-force",
		"passthrough-off",
		"passthrough-disclosure",
	]) {
		expect(q(id), id).toBeNull();
	}
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

describe("EncoderDialog — saved passthrough, route line + bitrate gate", () => {
	it("force + uvc_h264 + h264 out → untouched route, bitrate disabled with reason, force notice", () => {
		reactiveSources.value = sourcesMessage([UVC_H264]);
		reactiveConfig.value = {
			source: "uvc-0",
			pipeline: "libuvch264",
			video_codec: "h264",
			video_passthrough: "force",
		} as never;

		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ codec: "h264" }),
				onResetPassthrough: vi.fn(async () => true),
			},
		});
		flushSync();

		expectNoPassthroughSelector();
		expect(q("encoder-route")?.getAttribute("data-route")).toBe("untouched");
		expect(q("encoder-legacy-passthrough")?.getAttribute("data-setting")).toBe(
			"force",
		);
		expect(q("encoder-legacy-passthrough-reset")).not.toBeNull();

		// The disabled reason is VISIBLE without interacting with the slider.
		const reason = q("bitrate-passthrough-disabled");
		expect(reason).not.toBeNull();
		expect(reason?.textContent?.trim()).not.toBe("");

		// Both bitrate controls are disabled.
		const slider = document.body.querySelector(
			'[data-testid="encoder-bitrate-control"] [role="slider"]',
		);
		expect(slider?.getAttribute("data-disabled")).not.toBeNull();
		const input = document.body.querySelector(
			"#encoder-bitrate",
		) as HTMLInputElement | null;
		expect(input?.disabled).toBe(true);
	});

	it("force + mjpeg source → forceUnavailable route (start would fail typed), force notice", () => {
		reactiveSources.value = sourcesMessage([MJPEG]);
		reactiveConfig.value = {
			source: "rode-0",
			pipeline: "usb_mjpeg",
			video_codec: "h264",
			video_passthrough: "force",
		} as never;

		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ codec: "h264" }),
				onResetPassthrough: vi.fn(async () => true),
			},
		});
		flushSync();

		expectNoPassthroughSelector();
		expect(q("encoder-route")?.getAttribute("data-route")).toBe(
			"forceUnavailable",
		);
		expect(q("encoder-legacy-passthrough")?.getAttribute("data-setting")).toBe(
			"force",
		);
		// Bitrate stays enabled (nothing passes through).
		expect(q("bitrate-passthrough-disabled")).toBeNull();
	});

	it("auto + uvc_h264 → adaptive switch on, same-format route, no notice", () => {
		reactiveSources.value = sourcesMessage([UVC_H264]);
		reactiveConfig.value = {
			source: "uvc-0",
			pipeline: "libuvch264",
			video_codec: "h264",
			video_passthrough: "auto",
		} as never;

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig({ codec: "h264" }) },
		});
		flushSync();

		expectNoPassthroughSelector();
		expect(q("encoder-adaptive")?.getAttribute("aria-checked")).toBe("true");
		expect(q("encoder-route")?.getAttribute("data-route")).toBe(
			"sameFormatAdapted",
		);
		expect(q("encoder-legacy-passthrough")).toBeNull();
		const input = document.body.querySelector(
			"#encoder-bitrate",
		) as HTMLInputElement | null;
		expect(input?.disabled).toBe(false);
	});

	it("off + uvc_h264 → the off notice with its reset, same-format route", () => {
		reactiveSources.value = sourcesMessage([UVC_H264]);
		reactiveConfig.value = {
			source: "uvc-0",
			pipeline: "libuvch264",
			video_codec: "h264",
			video_passthrough: "off",
		} as never;

		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ codec: "h264" }),
				onResetPassthrough: vi.fn(async () => true),
			},
		});
		flushSync();

		expectNoPassthroughSelector();
		expect(q("encoder-legacy-passthrough")?.getAttribute("data-setting")).toBe(
			"off",
		);
		expect(q("encoder-legacy-passthrough-reset")).not.toBeNull();
		expect(q("encoder-route")?.getAttribute("data-route")).toBe(
			"sameFormatAdapted",
		);
	});
});
