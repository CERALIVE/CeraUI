// @vitest-environment jsdom
/**
 * EncoderDialog — automatic output format, the adaptive switch and the route line.
 *
 * The dialog never asks for an encode mode: the format is the engine's default
 * unless the operator opts into choosing one, the "Adapt bitrate to the network"
 * switch stands for the balancer, and one line says what the device will do.
 * A save writes only the format keys the operator changed, through the same
 * `buildEncoderSetConfig` mapper LiveView and the federated bundle use.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	ActiveEncode,
	CaptureStreamSource,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
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

import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import {
	reactiveConfig,
	reactiveSources,
} from "../../tests/fixtures/reactive-subscriptions.svelte";
import type { EncoderConfig } from "./EncoderDialog.svelte";
import EncoderDialog from "./EncoderDialog.svelte";

const engine = vi.hoisted(() => ({
	defaultCodec: "h265" as string | undefined,
	isStreaming: false,
}));

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
				...(engine.defaultCodec ? { default_codec: engine.defaultCodec } : {}),
			},
			sources: [],
		}),
		getDevices: () => undefined,
		getIsStreaming: () => engine.isStreaming,
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

const H265_CAM: CaptureStreamSource = {
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
};

const MJPEG_CAM: CaptureStreamSource = {
	...H265_CAM,
	id: "rode-0",
	pipelineId: "usb_mjpeg",
	kind: "mjpeg",
	displayName: "MJPEG Cam",
	modes: [
		{ width: 1920, height: 1080, framerates: [30], media_type: "image/jpeg" },
	],
};

function sources(...list: CaptureStreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources: list } as SourcesMessage;
}

function draft(partial: Partial<EncoderConfig> = {}): EncoderConfig {
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

function saveButton(): HTMLButtonElement {
	const button = [...document.body.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === m["dialogs.save"](),
	);
	if (!button) throw new Error("save button not rendered");
	return button;
}

async function saveAndReadPayload(onSave: ReturnType<typeof vi.fn>) {
	await fireEvent.click(saveButton());
	expect(onSave).toHaveBeenCalledTimes(1);
	return buildEncoderSetConfig(
		onSave.mock.calls[0][0] as EncoderConfig,
		undefined,
	);
}

function mount(props: Record<string, unknown> = {}) {
	const onSave = vi.fn();
	render(EncoderDialog, {
		props: { open: true, config: draft(), onSave, ...props },
	});
	flushSync();
	return onSave;
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
	engine.defaultCodec = "h265";
	engine.isStreaming = false;
	reactiveConfig.reset();
	reactiveSources.reset();
	reactiveSources.value = sources(H265_CAM, MJPEG_CAM);
	reactiveConfig.value = {
		source: "cam-h265",
		pipeline: "libuvch265",
	} as never;
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

describe("EncoderDialog — automatic format", () => {
	it("names the engine's default and offers no codec until the operator opts in", () => {
		mount();

		expect(q("encoder-format-automatic")?.textContent?.trim()).toBe(
			m["live.encoder.format.automatic"]({ codec: "H.265" }),
		);
		expect(q("encoder-format-manual")?.getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(q("encoder-format-h264")).toBeNull();
		expect(q("encoder-format-h265")).toBeNull();
		expect(q("encoder-codec-selector")).toBeNull();
	});

	it('renders "Automatic (AV1)" when the engine names AV1 as its default', () => {
		engine.defaultCodec = "av1";
		mount();

		expect(q("encoder-format-automatic")?.textContent?.trim()).toBe(
			m["live.encoder.format.automatic"]({ codec: "AV1" }),
		);
		expect(q("encoder-format-automatic")?.textContent).toContain("AV1");
	});

	it("says just Automatic when the engine does not name a default", () => {
		engine.defaultCodec = undefined;
		mount();

		expect(q("encoder-format-automatic")?.textContent?.trim()).toBe(
			m["live.encoder.format.automaticUnknown"](),
		);
	});

	it("is on, with the saved codec checked, when the saved config has a video_codec", () => {
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			video_codec: "h264",
		} as never;
		mount();

		expect(q("encoder-format-manual")?.getAttribute("aria-checked")).toBe(
			"true",
		);
		expect(q("encoder-format-h264")?.getAttribute("aria-checked")).toBe("true");
		expect(q("encoder-format-h265")?.getAttribute("aria-checked")).toBe(
			"false",
		);
	});
});

describe("EncoderDialog — saves only what the operator changed", () => {
	it("a fresh config saves no format key at all", async () => {
		const onSave = mount();

		const payload = await saveAndReadPayload(onSave);
		expect(payload).not.toHaveProperty("video_codec");
		expect(payload).not.toHaveProperty("balancer");
		expect(payload).not.toHaveProperty("video_passthrough");
	});

	it("turning the manual switch on and picking H.264 saves video_codec: 'h264'", async () => {
		const onSave = mount();

		await fireEvent.click(q("encoder-format-manual") as HTMLElement);
		await fireEvent.click(q("encoder-format-h264") as HTMLElement);

		const payload = await saveAndReadPayload(onSave);
		expect(payload.video_codec).toBe("h264");
		expect(payload).not.toHaveProperty("balancer");
	});

	it("turning the manual switch off saves video_codec: null", async () => {
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			video_codec: "h264",
		} as never;
		const onSave = mount();

		await fireEvent.click(q("encoder-format-manual") as HTMLElement);
		expect(q("encoder-format-h264")).toBeNull();

		const payload = await saveAndReadPayload(onSave);
		expect(payload).toHaveProperty("video_codec", null);
	});

	it("turning the adaptive switch off saves balancer: 'fixed'", async () => {
		const onSave = mount();
		const adaptive = q("encoder-adaptive") as HTMLElement;
		expect(adaptive.getAttribute("aria-checked")).toBe("true");

		await fireEvent.click(adaptive);

		const payload = await saveAndReadPayload(onSave);
		expect(payload.balancer).toBe("fixed");
		expect(payload).not.toHaveProperty("video_codec");
	});

	it("a saved aimd shows the switch on and is not rewritten on an unrelated save", async () => {
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			balancer: "aimd",
		} as never;
		const onSave = mount();

		expect(q("encoder-adaptive")?.getAttribute("aria-checked")).toBe("true");
		const input = document.body.querySelector(
			"#encoder-bitrate",
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "7000" } });

		const payload = await saveAndReadPayload(onSave);
		expect(payload.max_br).toBe(7000);
		expect(payload).not.toHaveProperty("balancer");
	});

	it("a saved fixed shows the switch off", () => {
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			balancer: "fixed",
		} as never;
		mount();

		expect(q("encoder-adaptive")?.getAttribute("aria-checked")).toBe("false");
	});

	it("disables the adaptive switch while streaming and says it applies on the next start", () => {
		engine.isStreaming = true;
		mount();

		const adaptive = q("encoder-adaptive") as HTMLButtonElement;
		expect(adaptive.disabled).toBe(true);
		expect(document.body.textContent).toContain(
			m["live.encoder.appliesNextStart"](),
		);
	});
});

describe("EncoderDialog — the route line", () => {
	it("reads sameFormatAdapted for an H.265 camera with adaptive bitrate on", () => {
		mount();

		const route = q("encoder-route");
		expect(route?.getAttribute("data-route")).toBe("sameFormatAdapted");
		expect(route?.textContent).toContain(
			m["live.encoder.route.sameFormatAdapted"]({ codec: "H.265" }),
		);
	});

	it("reads willTryUntouched once the adaptive switch is off", async () => {
		mount();

		await fireEvent.click(q("encoder-adaptive") as HTMLElement);

		const route = q("encoder-route");
		expect(route?.getAttribute("data-route")).toBe("willTryUntouched");
		expect(route?.textContent).toContain(
			m["live.encoder.route.willTryUntouched"]({ codec: "H.265" }),
		);
	});

	it("follows the codec the operator picks", async () => {
		mount();

		await fireEvent.click(q("encoder-format-manual") as HTMLElement);
		await fireEvent.click(q("encoder-format-h264") as HTMLElement);

		const route = q("encoder-route");
		expect(route?.getAttribute("data-route")).toBe("converted");
		expect(route?.textContent).toContain(
			m["live.encoder.route.converted"]({ input: "H.265", output: "H.264" }),
		);
	});

	it("shows the engine's route and its reason while live", () => {
		engine.isStreaming = true;
		const activeEncode: ActiveEncode = {
			codec: "h265",
			input_codec: "h264",
			resolution: "1920x1080",
			framerate: 30,
			route_reason: "cross-codec",
		};
		mount({ activeEncode });

		const route = q("encoder-route");
		expect(route?.getAttribute("data-route")).toBe("converted");
		expect(route?.textContent).toContain(
			m["live.encoder.route.reason.cross-codec"](),
		);
	});

	it("never prints an unknown engine reason token", () => {
		engine.isStreaming = true;
		mount({
			activeEncode: {
				codec: "h265",
				resolution: "1920x1080",
				framerate: 30,
				route_reason: "future-reason",
			} satisfies ActiveEncode,
		});

		expect(q("encoder-route")?.getAttribute("data-route")).toBe("encoded");
		expect(q("encoder-route")?.textContent).not.toContain("future-reason");
	});
});

describe("EncoderDialog — a saved Passthrough choice", () => {
	it("force with an MJPEG source renders forceUnavailable, never untouched, with the reset button", () => {
		reactiveConfig.value = {
			source: "rode-0",
			pipeline: "usb_mjpeg",
			video_passthrough: "force",
		} as never;
		mount({ onResetPassthrough: vi.fn(async () => true) });

		const route = q("encoder-route");
		expect(route?.getAttribute("data-route")).toBe("forceUnavailable");
		expect(route?.textContent).toContain(
			m["live.encoder.route.forceUnavailable"]({ codec: "H.265" }),
		);
		expect(route?.textContent).not.toContain(
			m["live.encoder.route.untouched"]({ codec: "H.265" }),
		);
		expect(q("encoder-legacy-passthrough")).not.toBeNull();
		expect(q("encoder-legacy-passthrough")?.textContent).toContain(
			m["live.encoder.legacy.force"](),
		);
		expect(q("encoder-legacy-passthrough-reset")).not.toBeNull();
	});

	it("the reset saves video_passthrough auto, then the notice goes and the route names a re-encode", async () => {
		reactiveConfig.value = {
			source: "rode-0",
			pipeline: "usb_mjpeg",
			video_passthrough: "force",
		} as never;
		const onResetPassthrough = vi.fn(async () => true);
		const onSave = mount({ onResetPassthrough });

		await fireEvent.click(q("encoder-legacy-passthrough-reset") as HTMLElement);
		await Promise.resolve();
		flushSync();

		expect(onResetPassthrough).toHaveBeenCalledTimes(1);
		expect(q("encoder-legacy-passthrough")).toBeNull();
		expect(q("encoder-route")?.getAttribute("data-route")).toBe("converted");
		expect(q("encoder-route")?.textContent).toContain(
			m["live.encoder.route.converted"]({ input: "MJPEG", output: "H.265" }),
		);
		const payload = await saveAndReadPayload(onSave);
		expect(payload).not.toHaveProperty("video_passthrough");
	});

	it("keeps the notice when the reset is refused", async () => {
		reactiveConfig.value = {
			source: "rode-0",
			pipeline: "usb_mjpeg",
			video_passthrough: "force",
		} as never;
		mount({ onResetPassthrough: vi.fn(async () => false) });

		await fireEvent.click(q("encoder-legacy-passthrough-reset") as HTMLElement);
		await Promise.resolve();
		flushSync();

		expect(q("encoder-legacy-passthrough")).not.toBeNull();
		expect(q("encoder-route")?.getAttribute("data-route")).toBe(
			"forceUnavailable",
		);
	});

	it("shows the off notice for a saved off, and none for auto", () => {
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			video_passthrough: "off",
		} as never;
		mount({ onResetPassthrough: vi.fn(async () => true) });
		expect(q("encoder-legacy-passthrough")?.textContent).toContain(
			m["live.encoder.legacy.off"](),
		);

		document.body.innerHTML = "";
		reactiveConfig.value = {
			source: "cam-h265",
			pipeline: "libuvch265",
			video_passthrough: "auto",
		} as never;
		mount({ onResetPassthrough: vi.fn(async () => true) });
		expect(q("encoder-legacy-passthrough")).toBeNull();
	});
});
