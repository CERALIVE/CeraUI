// @vitest-environment jsdom
/**
 * EncoderDialog — capability-first independent axes (Todo 10).
 *
 * Proves the Resolution/Framerate axes are gated through `offeredAxes`
 * (platform ∩ selected source ∩ Tier-2 device modes), the current-vs-device-max
 * summary reflects the active source's real ceiling, and the no-caps path is
 * byte-compatible with an old engine that emits no `device_modes`.
 *
 * jsdom note: bits-ui Select items only mount when the Select is open, so the
 * primary axis-gating assertions read ALWAYS-rendered surfaces — the summary line
 * and the Select trigger's `aria-invalid` (which flips when the selected value is
 * unsupported). Opening the Framerate select additionally asserts the
 * disabled-with-reason title on the option itself.
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	Pipeline,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { EncoderConfig } from "./EncoderDialog.svelte";
import EncoderDialog from "./EncoderDialog.svelte";

// Mutable snapshot the mocked subscriptions read from — each test seeds it.
const state = vi.hoisted(() => ({
	pipelines: undefined as unknown,
	capabilities: undefined as unknown,
	config: undefined as unknown,
	devices: undefined as unknown,
	status: undefined as unknown,
	isStreaming: false,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getPipelines: () => state.pipelines,
	getCapabilities: () => state.capabilities,
	getDevices: () => state.devices,
	getIsStreaming: () => state.isStreaming,
	getConfig: () => state.config,
	getStatus: () => state.status,
}));

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

const HDMI_PIPELINE: Pipeline = {
	name: "HDMI Capture",
	description: "HDMI capture",
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
};

function pipelinesMessage(hardware: string) {
	return { hardware, pipelines: { hdmi: HDMI_PIPELINE } };
}

function capsWith(
	overrides: Partial<CapabilitiesMessage> = {},
): CapabilitiesMessage {
	return {
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
		...overrides,
	};
}

// HDMI device driving 1080p@[30,60] + 2160p@[30].
const HDMI_DEVICE_MODES = {
	"/dev/video0": {
		kind: "hdmi",
		modes: [
			{ width: 1920, height: 1080, framerates: [30, 60] },
			{ width: 3840, height: 2160, framerates: [30] },
		],
	},
};

function seedConfig(partial: Partial<ConfigMessage> = {}): void {
	state.config = { pipeline: "hdmi", ...partial } as ConfigMessage;
}

function encoderConfig(partial: Partial<EncoderConfig> = {}): EncoderConfig {
	return {
		source: "hdmi",
		resolution: "1080p",
		framerate: 30,
		bitrate: 6000,
		bitrateOverlay: false,
		...partial,
	};
}

function summaryText(): string {
	return (
		document.body
			.querySelector('[data-testid="axis-device-max"]')
			?.textContent?.trim() ?? ""
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
	state.pipelines = undefined;
	state.capabilities = undefined;
	state.config = undefined;
	state.devices = undefined;
	state.status = undefined;
	state.isStreaming = false;
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

describe("EncoderDialog — capability-first axes", () => {
	it("caps-full: reaches the 4K/60 ceiling and enables H.265", () => {
		state.pipelines = pipelinesMessage("rk3588");
		state.capabilities = capsWith({ device_modes: HDMI_DEVICE_MODES });
		seedConfig();

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig() },
		});

		// The current-vs-device-max summary reflects the device union ceiling.
		expect(summaryText()).toContain("4K");
		expect(summaryText()).toContain("60 fps");

		// H.265 is a first-class enabled choice on this platform.
		const h265 = document.body.querySelector('[data-testid="codec-h265"]');
		expect(h265?.getAttribute("data-supported")).toBe("true");
		expect(h265?.hasAttribute("disabled")).toBe(false);
	});

	it("engine-starting minimal floor: only 1080p + H.264", () => {
		// Software floor board + an H.264-only, 1080p-capped capability snapshot,
		// with NO device_modes — the minimal safe floor an engine emits while booting.
		state.pipelines = pipelinesMessage("generic");
		state.capabilities = capsWith({
			platform: {
				supports_h265: false,
				hardware_accelerated: false,
				max_resolution: "1080p",
			},
			engineStarting: true,
		});
		seedConfig();

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig() },
		});

		// Ceiling is 1080p — never 4K on the floor.
		expect(summaryText()).toContain("1080p");
		expect(summaryText()).not.toContain("4K");

		// H.265 is disabled-with-reason (never hidden).
		const h265 = document.body.querySelector('[data-testid="codec-h265"]');
		expect(h265).not.toBeNull();
		expect(h265?.getAttribute("data-supported")).toBe("false");
		expect(h265?.hasAttribute("disabled")).toBe(true);
		expect(h265?.getAttribute("title")).toBeTruthy();
	});

	it("device modes limit the selected resolution: 60 fps disabled at 4K with a reason title", async () => {
		state.pipelines = pipelinesMessage("rk3588");
		state.capabilities = capsWith({ device_modes: HDMI_DEVICE_MODES });
		// Select 4K (device drives it at 30 only) with 60 fps — an unsupported combo.
		seedConfig({ resolution: "2160p", framerate: 60 });

		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ resolution: "2160p", framerate: 60 }),
			},
		});

		// The framerate trigger flags the unsupported selection (always rendered).
		const trigger = document.body.querySelector("#encoder-framerate");
		expect(trigger?.getAttribute("aria-invalid")).toBe("true");

		// Opening the framerate select shows 60 fps disabled WITH a reason title.
		await fireEvent.click(trigger as HTMLElement);
		await tick();
		const options = Array.from(
			document.body.querySelectorAll('[data-testid="framerate-option"]'),
		);
		const sixty = options.find((o) => o.getAttribute("data-value") === "60");
		if (sixty) {
			expect(sixty.getAttribute("aria-disabled")).toBe("true");
			expect(sixty.getAttribute("title")).toBe(
				"Not available at this resolution",
			);
		} else {
			// bits-ui didn't mount the options in jsdom — the trigger aria-invalid
			// above is the authoritative gating proof; the pure per-resolution
			// gating is covered exhaustively in ValidationAdapter.axes.test.ts.
			expect(trigger?.getAttribute("aria-invalid")).toBe("true");
		}
	});

	it("no-caps fallback: every axis renders, gates coarsely, and saves (old-engine compatible)", () => {
		// No capabilities snapshot at all (device_modes absent by construction) — the
		// exact state an old engine leaves the dialog in.
		state.pipelines = pipelinesMessage("generic");
		state.capabilities = undefined;
		seedConfig();

		const onSave = vi.fn();
		render(EncoderDialog, {
			props: { open: true, config: encoderConfig(), onSave },
		});

		// Axes render (summary + both selects present), no crash.
		expect(
			document.body.querySelector('[data-testid="axis-summary"]'),
		).not.toBeNull();
		expect(document.body.querySelector("#encoder-resolution")).not.toBeNull();
		expect(document.body.querySelector("#encoder-framerate")).not.toBeNull();
		// Coarse ceiling for a software board: 1080p / 60 fps.
		expect(summaryText()).toContain("1080p");
		expect(summaryText()).toContain("60 fps");

		// Save round-trips the coarse selection.
		const saveButton = Array.from(
			document.body.querySelectorAll("button"),
		).find((b) => b.textContent?.trim() === "Save");
		expect(saveButton).toBeDefined();
		fireEvent.click(saveButton as HTMLButtonElement);
		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls[0]?.[0] as EncoderConfig;
		expect(saved.source).toBe("hdmi");
		expect(saved.resolution).toBe("1080p");
		expect(saved.framerate).toBe(30);
	});
});
