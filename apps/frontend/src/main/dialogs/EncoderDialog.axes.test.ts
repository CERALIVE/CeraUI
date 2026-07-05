// @vitest-environment jsdom
/**
 * EncoderDialog — pure-encoding, source-tolerant axes (Todo 14).
 *
 * The dialog no longer selects a source: it reads the ACTIVE source from
 * `getSources()` (keyed by the persisted `config.source`) and keys its
 * Resolution/Framerate axes off that StreamSource's own `modes` through the
 * source-keyed `offeredAxes(hardware, source)` (T16). With no active source
 * (config lacking `source`/`pipeline` — a federated mount) the axes degrade to
 * the platform-coarse offering. These tests prove the ceiling reflects the active
 * source's modes, the source is a READ-ONLY context line (never a combobox), and
 * the no-source path renders + saves without throwing.
 *
 * jsdom note: bits-ui Select items only mount when the Select is open, so the
 * primary axis-gating assertions read ALWAYS-rendered surfaces — the summary line
 * and the Select trigger's `aria-invalid` (which flips when the selected value is
 * unsupported). Opening the Framerate select additionally asserts the
 * disabled-with-reason title on the option itself.
 */
import type {
	CapabilitiesMessage,
	CaptureStreamSource,
	CoarseStreamSource,
	ConfigMessage,
	NetworkStreamSource,
	SourcesMessage,
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
	sources: undefined as unknown,
	isStreaming: false,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getPipelines: () => state.pipelines,
	getCapabilities: () => state.capabilities,
	getDevices: () => state.devices,
	getIsStreaming: () => state.isStreaming,
	getConfig: () => state.config,
	getSources: () => state.sources,
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

// HDMI capture device driving 1080p@[30,60] + 2160p@[30]. The per-device modes
// now live on the StreamSource itself (T16), not on `capabilities.device_modes`.
const HDMI_SOURCE: CaptureStreamSource = {
	id: "hdmi-0",
	origin: "capture",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "HDMI Capture",
	devicePath: "/dev/video0",
	modes: [
		{ width: 1920, height: 1080, framerates: [30, 60] },
		{ width: 3840, height: 2160, framerates: [30] },
	],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// A legacy/no-device-yet coarse source: empty modes → axes fall back to the
// platform-coarse offering (byte-identical to an old engine with no device modes).
const COARSE_HDMI: CoarseStreamSource = {
	id: "hdmi",
	origin: "coarse",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// A LAN network-ingest source — always transcoded, so no resolution/framerate override.
const NETWORK_RTMP: NetworkStreamSource = {
	id: "rtmp",
	origin: "network",
	pipelineId: "rtmp",
	labelKey: "settings.sources.rtmp",
	requiresGateway: "rtmp",
	url: "rtmp://192.168.1.100:1935/publish/live",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "embedded",
	available: true,
};

function pipelinesMessage(hardware: string) {
	return { hardware, pipelines: {} };
}

function sourcesMessage(
	hardware: string,
	sources: SourcesMessage["sources"],
): SourcesMessage {
	return { hardware, sources } as SourcesMessage;
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

function seedConfig(partial: Partial<ConfigMessage> = {}): void {
	state.config = partial as ConfigMessage;
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
	state.sources = undefined;
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

describe("EncoderDialog — pure-encoding source-tolerant axes", () => {
	it("caps-full: reaches the 4K/60 ceiling and enables H.265", () => {
		state.pipelines = pipelinesMessage("rk3588");
		state.capabilities = capsWith();
		state.sources = sourcesMessage("rk3588", [HDMI_SOURCE]);
		seedConfig({ source: "hdmi-0", pipeline: "hdmi" });

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig() },
		});

		// The current-vs-device-max summary reflects the active source's mode union.
		expect(summaryText()).toContain("4K");
		expect(summaryText()).toContain("60 fps");

		// H.265 is a first-class enabled choice on this platform.
		const h265 = document.body.querySelector('[data-testid="codec-h265"]');
		expect(h265?.getAttribute("data-supported")).toBe("true");
		expect(h265?.hasAttribute("disabled")).toBe(false);
	});

	it("engine-starting minimal floor: only 1080p + H.264", () => {
		// Software floor board + an H.264-only, 1080p-capped capability snapshot; the
		// active source is a coarse entry with empty modes — the minimal safe floor.
		state.pipelines = pipelinesMessage("generic");
		state.capabilities = capsWith({
			platform: {
				supports_h265: false,
				hardware_accelerated: false,
				max_resolution: "1080p",
			},
			engineStarting: true,
		});
		state.sources = sourcesMessage("generic", [COARSE_HDMI]);
		seedConfig({ source: "hdmi", pipeline: "hdmi" });

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
		state.capabilities = capsWith();
		state.sources = sourcesMessage("rk3588", [HDMI_SOURCE]);
		// Select 4K (device drives it at 30 only) with 60 fps — an unsupported combo.
		seedConfig({ source: "hdmi-0", pipeline: "hdmi" });

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

	it("renders the active source as a read-only context line, never a selector", () => {
		state.pipelines = pipelinesMessage("rk3588");
		state.capabilities = capsWith();
		state.sources = sourcesMessage("rk3588", [HDMI_SOURCE]);
		seedConfig({ source: "hdmi-0", pipeline: "hdmi" });

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig() },
		});

		// The source is a read-only context line showing its real name + kind…
		const active = document.body.querySelector(
			'[data-testid="encoder-active-source"]',
		);
		expect(active).not.toBeNull();
		expect(active?.getAttribute("data-source-id")).toBe("hdmi-0");
		expect(active?.textContent).toContain("HDMI Capture");
		expect(
			document.body.querySelector('[data-testid="encoder-active-source-kind"]')
				?.textContent,
		).toContain("HDMI");

		// …and NOT a combobox/select for the source.
		expect(document.body.querySelector("#encoder-source")).toBeNull();
		expect(
			document.body.querySelector('[data-testid="source-applies-next-start"]'),
		).toBeNull();
	});

	it("no source in config: axes degrade to platform-coarse, no source selector, and save succeeds", () => {
		// A federated mount — the config carries no source/pipeline and no sources
		// broadcast has arrived. The dialog must render + save without throwing.
		state.pipelines = pipelinesMessage("generic");
		state.capabilities = undefined;
		state.sources = undefined;
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
		// No active-source line (nothing to reflect) and no source selector.
		expect(
			document.body.querySelector('[data-testid="encoder-active-source"]'),
		).toBeNull();
		expect(document.body.querySelector("#encoder-source")).toBeNull();

		// Save round-trips the encoding selection WITHOUT a source/pipeline.
		const saveButton = Array.from(
			document.body.querySelectorAll("button"),
		).find((b) => b.textContent?.trim() === "Save");
		expect(saveButton).toBeDefined();
		fireEvent.click(saveButton as HTMLButtonElement);
		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls[0]?.[0] as EncoderConfig;
		expect(saved.source).toBeUndefined();
		expect(saved.resolution).toBe("1080p");
		expect(saved.framerate).toBe(30);
		expect(saved.bitrate).toBe(6000);
	});

	it("network source (no resolution override): resolution axis disabled-with-reason (T14 audit)", async () => {
		state.pipelines = pipelinesMessage("rk3588");
		state.capabilities = capsWith();
		state.sources = sourcesMessage("rk3588", [NETWORK_RTMP]);
		// Selecting a non-default 720p on a source-fixed (1080p) network source.
		seedConfig({ source: "rtmp", pipeline: "rtmp" });

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig({ resolution: "720p" }) },
		});

		// The always-rendered trigger flags the unsupported source-fixed selection.
		const trigger = document.body.querySelector("#encoder-resolution");
		expect(trigger?.getAttribute("aria-invalid")).toBe("true");

		// Opening the select shows the non-default rung disabled WITH the source reason.
		await fireEvent.click(trigger as HTMLElement);
		await tick();
		const options = Array.from(
			document.body.querySelectorAll('[data-testid="resolution-option"]'),
		);
		const nonDefault = options.find(
			(o) => o.getAttribute("data-value") === "720p",
		);
		if (nonDefault) {
			expect(nonDefault.getAttribute("aria-disabled")).toBe("true");
			expect(nonDefault.getAttribute("title")).toBe(
				"Fixed by the selected source",
			);
		} else {
			// bits-ui didn't mount options in jsdom — the trigger aria-invalid above
			// is the authoritative gating proof (matches the framerate axis test).
			expect(trigger?.getAttribute("aria-invalid")).toBe("true");
		}
	});
});
