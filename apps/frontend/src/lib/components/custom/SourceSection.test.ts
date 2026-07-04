// @vitest-environment jsdom
import type {
	AudioSource,
	CapabilitiesMessage,
	CaptureStreamSource,
	CoarseStreamSource,
	NetworkStreamSource,
	SourcesMessage,
	StreamSource,
	VirtualStreamSource,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// QR generation is stubbed so the unit never touches the real `qrcode` canvas
// path; it returns a deterministic data URL the render can assert against.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(
		async (url: string) => `data:image/png;qr(${url})`,
	),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

// SourceSection now owns the source-selection write: mock the RPC client so the
// setConfig({source}) dispatch is observable. The per-field-sync store is NOT
// mocked — the `source` lock is asserted against the real machine.
const setConfig = vi.hoisted(() =>
	vi.fn(async () => ({ success: true, applied: {} }) as unknown),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

import {
	destroyFieldSyncState,
	getFieldState,
} from "$lib/rpc/field-sync-state.svelte";
import SourceSection from "./SourceSection.svelte";

// ── StreamSource fixtures (one per origin) ──────────────────────────────────
// The RØDE dongle: a UVC (USB) device whose display name contains "HDMI". Its
// kind is `uvc_h264`, so it must render its REAL name under a USB glyph — never
// the coarse "HDMI Capture" label (the mislabel this whole model removes).
const RODE: CaptureStreamSource = {
	origin: "capture",
	id: "usb",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "RØDE HDMI to USB-C: RØDE HDMI",
	devicePath: "/dev/video1",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};
const HDMI_CAPTURE: CaptureStreamSource = {
	origin: "capture",
	id: "hdmi-rx",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "Rockchip HDMI-RX",
	devicePath: "/dev/video0",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};
const COARSE_HDMI: CoarseStreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};
const VIRTUAL_TEST: VirtualStreamSource = {
	origin: "virtual",
	id: "test",
	pipelineId: "test",
	labelKey: "settings.sources.test",
	modes: [],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "none",
	available: true,
};
const RTMP_URL = "rtmp://192.168.1.100:1935/publish/live";
function netRtmp(available: boolean): NetworkStreamSource {
	return {
		origin: "network",
		id: "rtmp",
		pipelineId: "rtmp",
		labelKey: "settings.sources.rtmp",
		requiresGateway: "rtmp",
		url: RTMP_URL,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available,
		...(available
			? {}
			: { unavailableReason: "live.education.reason.gatewayInactive" }),
	};
}

function sourcesMsg(list: StreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources: list };
}

function mount(props: Record<string, unknown> = {}) {
	return render(SourceSection, { props });
}

const CAPS: CapabilitiesMessage = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		{
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 60,
		},
	],
};

const CAPS_AUDIO_RTMP: CapabilitiesMessage = {
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
			id: "rtmp",
			supports_audio: true,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
};
const CAPS_EMBEDDED_ON: CapabilitiesMessage = {
	...CAPS_AUDIO_RTMP,
	network_embedded_audio: true,
};

afterEach(() => {
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} } as unknown);
	toastSuccess.mockClear();
	toastError.mockClear();
	// Reset the per-field-sync singleton so each test starts from a clean lock.
	destroyFieldSyncState();
});

describe("SourceSection — unified device-first source list (Task 13)", () => {
	it("renders the section and the unified source list", () => {
		const { container } = mount({ sources: sourcesMsg([RODE]) });
		expect(
			container.querySelector('[data-testid="source-section"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="source-list"]'),
		).not.toBeNull();
	});

	it("renders a capture row with the REAL device name + a USB kind badge, never 'HDMI Capture'", () => {
		const { container } = mount({ sources: sourcesMsg([RODE]) });
		const row = container.querySelector<HTMLElement>(
			'[data-testid="source-row-usb"]',
		);
		expect(row).not.toBeNull();
		expect(row?.textContent).toContain("RØDE HDMI to USB-C: RØDE HDMI");
		// The uvc_h264 dongle reads as a USB device (kind glyph + badge)…
		expect(row?.textContent).toContain("USB");
		expect(
			container.querySelector('[data-source-kind="uvc_h264"]'),
		).not.toBeNull();
		// …never the coarse "HDMI Capture" mislabel.
		expect(row?.textContent).not.toContain("HDMI Capture");
	});

	it("renders a coarse capability source as a SELECTABLE row with its labelKey label", () => {
		const { container } = mount({ sources: sourcesMsg([COARSE_HDMI]) });
		const row = container.querySelector<HTMLElement>(
			'[data-testid="source-row-hdmi"]',
		);
		expect(row?.textContent).toContain("HDMI Capture");
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-hdmi"]',
		);
		expect(btn).not.toBeNull();
		expect(btn?.disabled).toBe(false);
	});

	it("renders the Test-pattern virtual row exactly once", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, COARSE_HDMI, VIRTUAL_TEST, netRtmp(true)]),
		});
		expect(
			container.querySelectorAll('[data-testid="source-row-test"]'),
		).toHaveLength(1);
	});

	it("renders an unavailable network row disabled with a reason title (consumes source.available)", () => {
		const { container } = mount({ sources: sourcesMsg([netRtmp(false)]) });
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(btn?.disabled).toBe(true);
		expect(btn?.getAttribute("title")).toBeTruthy();
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-reason-rtmp"]',
			),
		).not.toBeNull();
	});
});

describe("SourceSection — source PRIORITY (capture rows only)", () => {
	it("renders NO reorder affordance with a single capture source", () => {
		const { container } = mount({ sources: sourcesMsg([RODE, COARSE_HDMI]) });
		expect(container.querySelector("[data-move-up]")).toBeNull();
	});

	it("renders the inline reorder affordance when two capture sources exist", () => {
		const { container } = mount({ sources: sourcesMsg([RODE, HDMI_CAPTURE]) });
		expect(container.querySelector("[data-move-up]")).not.toBeNull();
		expect(container.querySelector("[data-move-down]")).not.toBeNull();
	});

	it("dispatches onReorderSource when a capture row is moved", async () => {
		const onReorderSource = vi.fn();
		const { container } = mount({
			sources: sourcesMsg([RODE, HDMI_CAPTURE]),
			sourceOrder: ["usb", "hdmi-rx"],
			onReorderSource,
		});
		const down = container.querySelector<HTMLButtonElement>(
			'[data-move-down="usb"]',
		);
		await fireEvent.click(down!);
		expect(onReorderSource).toHaveBeenCalledWith("usb", "down");
	});
});

describe("SourceSection — source selection (config.source via field-sync)", () => {
	it("dispatches setConfig({source}) when a coarse row is selected", async () => {
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: {},
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-hdmi"]',
		);
		await fireEvent.click(btn!);
		expect(setConfig).toHaveBeenCalledWith({ source: "hdmi" });
	});

	it("dispatches setConfig({source}) when a network row is selected", async () => {
		const { container } = mount({
			sources: sourcesMsg([netRtmp(true)]),
			config: {},
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		await fireEvent.click(btn!);
		expect(setConfig).toHaveBeenCalledWith({ source: "rtmp" });
	});

	it("locks the source field until the applied echo (applying → applied)", async () => {
		let resolveSet: (value: unknown) => void = () => {};
		setConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSet = resolve;
				}),
		);
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: {},
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-hdmi"]',
		);
		await fireEvent.click(btn!);
		expect(setConfig).toHaveBeenCalledWith({ source: "hdmi" });
		// The lock is held while the RPC is in flight.
		expect(getFieldState("source")).toBe("applying");
		// Release on the applied echo — never the optimistic value.
		resolveSet({ success: true, applied: { source: "hdmi" } });
		await waitFor(() => expect(getFieldState("source")).toBe("applied"));
	});

	it("releases the source lock to failed when setConfig rejects", async () => {
		let rejectSet: (reason?: unknown) => void = () => {};
		setConfig.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectSet = reject;
				}),
		);
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "test" },
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-hdmi"]',
		);
		await fireEvent.click(btn!);
		expect(getFieldState("source")).toBe("applying");
		rejectSet(new Error("boom"));
		await waitFor(() => expect(getFieldState("source")).toBe("failed"));
		expect(toastError).toHaveBeenCalled();
	});

	it("does not re-dispatch when the already-selected row is clicked", async () => {
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "hdmi" },
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-hdmi"]',
		);
		await fireEvent.click(btn!);
		expect(setConfig).not.toHaveBeenCalled();
	});
});

describe("SourceSection — network-ingest rows folded into the list (Task 12)", () => {
	it("renders no network rows when the list carries none", () => {
		const { container } = mount({ sources: sourcesMsg([RODE]) });
		expect(
			container.querySelector('[data-testid="source-network-ingest-select-rtmp"]'),
		).toBeNull();
	});

	it("renders the publish URL + QR for an active network source and copies it", async () => {
		const writeText = vi.fn(async () => {});
		Object.assign(navigator, { clipboard: { writeText } });
		const { container } = mount({ sources: sourcesMsg([netRtmp(true)]) });

		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(btn?.disabled).toBe(false);
		expect(
			container
				.querySelector('[data-testid="source-network-ingest-url-rtmp"]')
				?.textContent?.trim(),
		).toBe(RTMP_URL);

		await waitFor(() =>
			expect(
				container.querySelector(
					'[data-testid="source-network-ingest-qr-rtmp"]',
				),
			).not.toBeNull(),
		);

		const copy = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-copy-rtmp"]',
		);
		await fireEvent.click(copy!);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(RTMP_URL));
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("shows an 'includes audio' chip only when the network source advertises audio", () => {
		const withAudio = mount({ sources: sourcesMsg([netRtmp(true)]) });
		expect(
			withAudio.container.querySelector(
				'[data-testid="source-network-audio-rtmp"]',
			),
		).not.toBeNull();

		const noAudio = mount({
			sources: sourcesMsg([{ ...netRtmp(true), supportsAudio: false }]),
		});
		expect(
			noAudio.container.querySelector(
				'[data-testid="source-network-audio-rtmp"]',
			),
		).toBeNull();
	});
});

describe("SourceSection — capability summary (kept)", () => {
	it("derives a compact capability summary (res/fps/codec) from capabilities", () => {
		const { container } = mount({ sources: sourcesMsg([RODE]), capabilities: CAPS });
		const caps = container.querySelector<HTMLElement>(
			'[data-testid="source-capabilities"]',
		);
		if (!caps) throw new Error("capability summary not rendered");
		expect(caps.textContent).toContain("1080p");
		expect(caps.textContent).toContain("60fps");
		expect(caps.textContent).toContain("H.264");
		expect(caps.textContent).toContain("H.265");
		expect(container.querySelector('[data-testid="cap-audio"]')).not.toBeNull();
	});

	it("omits the capability summary entirely when no capabilities have arrived", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE]),
			capabilities: undefined,
		});
		expect(
			container.querySelector('[data-testid="source-capabilities"]'),
		).toBeNull();
	});
});

describe("SourceSection — lost device explanation (from source.lost)", () => {
	it("shows an explicit lost-device banner when a capture source is lost", () => {
		const lost: CaptureStreamSource = { ...RODE, lost: true };
		const { container } = mount({ sources: sourcesMsg([lost]) });
		const banner = container.querySelector<HTMLElement>(
			'[data-testid="source-lost-banner"]',
		);
		if (!banner) throw new Error("lost banner not rendered");
		expect(banner.textContent).toMatch(/disconnect/i);
		expect(banner.textContent).toMatch(/reconnect/i);
	});

	it("hides the lost-device banner when every capture source is healthy", () => {
		const { container } = mount({ sources: sourcesMsg([RODE]) });
		expect(
			container.querySelector('[data-testid="source-lost-banner"]'),
		).toBeNull();
	});
});

describe("SourceSection — audio source single vs multiple (kept)", () => {
	it("renders a SINGLE audio source read-only (no misleading dropdown)", () => {
		const { container } = mount({ audioSources: ["alsa:usbaudio"] });
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly).not.toBeNull();
		expect(readonly?.textContent).toContain("alsa:usbaudio");
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).toBeNull();
	});

	it("renders MULTIPLE audio sources as a selectable control pre-start", () => {
		const { container } = mount({
			audioSources: ["alsa:usbaudio", "alsa:hdmi"],
		});
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-readonly"]'),
		).toBeNull();
	});

	it("forces audio source READ-ONLY while streaming (live switch gated, Task 10)", () => {
		const { container } = mount({
			audioSources: ["alsa:usbaudio", "alsa:hdmi"],
			selectedAudioSource: "alsa:hdmi",
			isStreaming: true,
		});
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).toBeNull();
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly?.textContent).toContain("alsa:hdmi");
	});

	it("shows an explanatory placeholder when no audio source is reported", () => {
		const { container } = mount({ audioSources: [] });
		expect(
			container.querySelector('[data-testid="audio-source-none"]'),
		).not.toBeNull();
	});

	it("fires onSelectAudioSource when a multi-source selection is made", async () => {
		const onSelectAudioSource = vi.fn();
		const { container } = mount({
			audioSources: ["alsa:usbaudio", "alsa:hdmi"],
			onSelectAudioSource,
		});
		const nativeOption = container.querySelector<HTMLOptionElement>(
			'option[value="alsa:hdmi"]',
		);
		if (nativeOption) {
			const nativeSelect = nativeOption.closest("select");
			if (nativeSelect) {
				await fireEvent.change(nativeSelect, {
					target: { value: "alsa:hdmi" },
				});
				expect(onSelectAudioSource).toHaveBeenCalledWith("alsa:hdmi");
			}
		}
	});
});

describe("SourceSection — configured-but-unavailable audio source (kept)", () => {
	it("renders the configured value as a visible unavailable entry (no orphan)", () => {
		const { container } = mount({
			audioSources: ["No audio", "Pipeline default"],
			selectedAudioSource: "USB audio",
		});
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).not.toBeNull();
		const marker = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-unavailable"]',
		);
		expect(marker).not.toBeNull();
		expect(marker?.textContent).toContain("USB audio");
	});
});

describe("SourceSection — embedded network-ingest audio (Task 13)", () => {
	it("renders the read-only embedded state (no ALSA picker) WITH the capability", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			config: { source: "rtmp" },
			sources: sourcesMsg([netRtmp(true)]),
			capabilities: CAPS_EMBEDDED_ON,
		});
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-readonly"]'),
		).toBeNull();
	});

	it("keeps the ALSA picker WITHOUT the capability (TD-embedded-audio pill relocated to IdleCockpit roadmap, T12)", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			config: { source: "rtmp" },
			sources: sourcesMsg([netRtmp(true)]),
			capabilities: CAPS_AUDIO_RTMP,
		});
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-debt-id="TD-embedded-audio"]'),
		).toBeNull();
	});

	it("does not treat a selectable source as embedded even with the capability on", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			config: { source: "hdmi" },
			sources: sourcesMsg([COARSE_HDMI]),
			capabilities: CAPS_EMBEDDED_ON,
		});
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).not.toBeNull();
	});
});

describe("SourceSection — typed audio-source model (Task 13)", () => {
	it("consumes the typed audio_sources list (pseudo read-only label)", () => {
		const { container } = mount({
			audioSources: ["Pipeline default"],
			audioSourceList: [
				{
					id: "Pipeline default",
					kind: "pipeline_default",
					labelKey: "audio.sources.pipelineDefault",
				},
			] as AudioSource[],
		});
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly).not.toBeNull();
		expect(readonly?.textContent).toContain("Pipeline default");
	});
});
