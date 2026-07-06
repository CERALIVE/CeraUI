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
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
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

// Operator-disabled (the Settings toggle is OFF): available:false carrying the
// DISTINCT disabledInSettings reason (T6/T7) — the ONLY verdict that HIDES a row
// (Task 9), as opposed to gateway-inactive which stays visible disabled-with-reason.
function netRtmpDisabledInSettings(): NetworkStreamSource {
	return {
		...netRtmp(false),
		unavailableReason: "live.education.reason.disabledInSettings",
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

describe("SourceSection — operator-disabled network rows hidden, fail-visible when selected (Task 9)", () => {
	it("HIDES an operator-disabled network row that is NOT the selected source", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, netRtmpDisabledInSettings()]),
			config: {},
		});
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-select-rtmp"]',
			),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="source-row-rtmp"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="source-row-usb"]'),
		).not.toBeNull();
	});

	it("KEEPS an operator-disabled network row visible disabled-with-reason when it IS the selected source", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, netRtmpDisabledInSettings()]),
			config: { source: "rtmp" },
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(btn).not.toBeNull();
		expect(btn?.disabled).toBe(true);
		expect(btn?.getAttribute("title")).toBeTruthy();
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-reason-rtmp"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-settings-hint-rtmp"]',
			),
		).not.toBeNull();
	});

	it("does NOT hide a gateway-inactive row — only operator-disable hides (regression)", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, netRtmp(false)]),
			config: {},
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(btn).not.toBeNull();
		expect(btn?.disabled).toBe(true);
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-settings-hint-rtmp"]',
			),
		).toBeNull();
	});

	it("renders the same-LAN InfoPopover on an ENABLED network row, and NOT on a disabled one", () => {
		const enabled = mount({ sources: sourcesMsg([netRtmp(true)]), config: {} });
		expect(
			enabled.container.querySelector(
				'[data-testid="source-network-ingest-info-rtmp"]',
			),
		).not.toBeNull();

		const disabled = mount({
			sources: sourcesMsg([netRtmpDisabledInSettings()]),
			config: { source: "rtmp" },
		});
		expect(
			disabled.container.querySelector(
				'[data-testid="source-network-ingest-info-rtmp"]',
			),
		).toBeNull();
	});
});

describe("SourceSection — capture rows render without reorder affordance", () => {
	it("renders NO reorder chevrons even with two capture sources", () => {
		const { container } = mount({ sources: sourcesMsg([RODE, HDMI_CAPTURE]) });
		expect(container.querySelector("[data-move-up]")).toBeNull();
		expect(container.querySelector("[data-move-down]")).toBeNull();
		expect(
			container.querySelector('[data-testid^="source-reorder-"]'),
		).toBeNull();
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
			container.querySelector(
				'[data-testid="source-network-ingest-select-rtmp"]',
			),
		).toBeNull();
	});

	it("renders the publish URL + QR for the SELECTED active network source and copies it (Task 13)", async () => {
		const writeText = vi.fn(async () => {});
		Object.assign(navigator, { clipboard: { writeText } });
		// The "How to publish" QR/instructions block renders ONLY on the SELECTED
		// network row (Task 13) — select rtmp so the disclosure mounts.
		const { container } = mount({
			sources: sourcesMsg([netRtmp(true)]),
			config: { source: "rtmp" },
		});

		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(btn).not.toBeNull();
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

	it("renders the publish instructions ONLY on the selected network row, never an unselected enabled one (Task 13)", async () => {
		// UNSELECTED enabled network row: the row + status + audio chip render, but
		// the QR/instructions disclosure (toggle + details + QR) does NOT.
		const unselected = mount({ sources: sourcesMsg([netRtmp(true)]) });
		expect(
			unselected.container.querySelector(
				'[data-testid="source-network-ingest-select-rtmp"]',
			),
		).not.toBeNull();
		expect(
			unselected.container.querySelector(
				'[data-testid="source-network-ingest-status-rtmp"]',
			),
		).not.toBeNull();
		expect(
			unselected.container.querySelector(
				'[data-testid="source-network-ingest-instructions-toggle-rtmp"]',
			),
		).toBeNull();
		expect(
			unselected.container.querySelector(
				'[data-testid="source-network-ingest-instructions-rtmp"]',
			),
		).toBeNull();
		// No QR is generated for an unselected row (perf narrowing).
		await waitFor(() =>
			expect(
				unselected.container.querySelector(
					'[data-testid="source-network-ingest-qr-rtmp"]',
				),
			).toBeNull(),
		);

		// SELECTED: the disclosure toggle + details container appear.
		const selected = mount({
			sources: sourcesMsg([netRtmp(true)]),
			config: { source: "rtmp" },
		});
		expect(
			selected.container.querySelector(
				'[data-testid="source-network-ingest-instructions-toggle-rtmp"]',
			),
		).not.toBeNull();
		expect(
			selected.container.querySelector(
				'[data-testid="source-network-ingest-instructions-rtmp"]',
			),
		).not.toBeNull();
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

	it("renders per-protocol codec education under the SELECTED network row disclosure (T14, scoped to selected by Task 13)", () => {
		const netSrt: NetworkStreamSource = {
			...netRtmp(true),
			id: "srt",
			pipelineId: "srt",
			labelKey: "settings.sources.srt",
			requiresGateway: "srt",
			url: "srt://192.168.1.100:4001",
		};

		const rtmpSelected = mount({
			sources: sourcesMsg([netRtmp(true), netSrt]),
			config: { source: "rtmp" },
		});
		const rtmp = rtmpSelected.container.querySelector(
			'[data-testid="source-network-ingest-codec-education-rtmp"]',
		);
		expect(rtmp?.textContent).toContain("H.264");
		expect(rtmp?.textContent).not.toContain("H.265");
		expect(rtmp?.textContent).toContain("re-encoded");
		expect(
			rtmpSelected.container.querySelector(
				'[data-testid="source-network-ingest-codec-education-srt"]',
			),
		).toBeNull();

		const srtSelected = mount({
			sources: sourcesMsg([netRtmp(true), netSrt]),
			config: { source: "srt" },
		});
		const srt = srtSelected.container.querySelector(
			'[data-testid="source-network-ingest-codec-education-srt"]',
		);
		expect(srt?.textContent).toContain("H.265");
		expect(srt?.textContent).toContain("re-encoded");
		expect(
			srtSelected.container.querySelector(
				'[data-testid="source-network-ingest-codec-education-rtmp"]',
			),
		).toBeNull();
	});
});

describe("SourceSection — capability summary (kept)", () => {
	it("derives a compact capability summary (res/fps/codec) from capabilities", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE]),
			capabilities: CAPS,
		});
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

	it("shows the ACHIEVABLE pair — 1080p + 30fps for a 1080p@30 + 720p@60 source, never the cross-mode 60fps (Todo 3)", () => {
		const CAPS_CROSSMODE: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "4k",
			},
			encoder: {
				codecs: ["h264"],
				bitrate_range: { min: 500, max: 50000, unit: "kbps" },
			},
			sources: [
				{
					id: "usb",
					supports_audio: false,
					supports_resolution_override: true,
					supports_framerate_override: true,
					default_resolution: "1080p",
					default_framerate: 60,
				},
			],
			device_modes: {
				"/dev/video1": {
					kind: "uvc_h264",
					modes: [
						{ width: 1920, height: 1080, framerates: [30] },
						{ width: 1280, height: 720, framerates: [30, 60] },
					],
				},
			},
		};
		const { container } = mount({
			sources: sourcesMsg([RODE]),
			capabilities: CAPS_CROSSMODE,
			config: { pipeline: "usb", selected_video_input: "/dev/video1" },
		});
		const caps = container.querySelector<HTMLElement>(
			'[data-testid="source-capabilities"]',
		);
		if (!caps) throw new Error("capability summary not rendered");
		expect(caps.textContent).toContain("1080p");
		expect(caps.textContent).toContain("30fps");
		expect(caps.textContent).not.toContain("60fps");
		expect(
			container.querySelector('[data-testid="cap-device-max"]'),
		).not.toBeNull();
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

describe("SourceSection — Codec & delay affordance (one audio surface, T11)", () => {
	it("renders open-audio-dialog exactly once and dispatches onOpenAudioDialog", async () => {
		const onOpenAudioDialog = vi.fn();
		const { container } = mount({
			audioSources: ["alsa:usbaudio"],
			onOpenAudioDialog,
		});
		const buttons = container.querySelectorAll(
			'[data-testid="open-audio-dialog"]',
		);
		expect(buttons).toHaveLength(1);
		await fireEvent.click(buttons[0] as HTMLElement);
		expect(onOpenAudioDialog).toHaveBeenCalledTimes(1);
	});

	it("hides the affordance while streaming (audio surface read-only)", () => {
		const onOpenAudioDialog = vi.fn();
		const { container } = mount({
			audioSources: ["alsa:usbaudio"],
			isStreaming: true,
			onOpenAudioDialog,
		});
		expect(
			container.querySelector('[data-testid="open-audio-dialog"]'),
		).toBeNull();
	});

	it("renders no affordance when onOpenAudioDialog is not provided", () => {
		const { container } = mount({ audioSources: ["alsa:usbaudio"] });
		expect(
			container.querySelector('[data-testid="open-audio-dialog"]'),
		).toBeNull();
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

describe("SourceSection — Auto resolved preview (T6)", () => {
	it("renders the 'Auto → device' resolved line when Auto is active and resolved", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["USB audio", "HDMI"],
			audioStatus: { resolved_asrc: "USB audio" },
		});
		const line = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-auto-resolved"]',
		);
		expect(line).not.toBeNull();
		expect(line?.textContent).toContain("Auto \u2192 USB audio");
	});

	it("renders an em-dash when Auto is active but unresolved (old backend)", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["USB audio", "HDMI"],
			audioStatus: {},
		});
		const line = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-auto-resolved"]',
		);
		expect(line).not.toBeNull();
		expect(line?.textContent?.trim()).toBe("\u2014");
		// The two null cases are visually distinct: no embedded state here.
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).toBeNull();
	});

	it("renders the embedded state (not the em-dash) for the embedded reason", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["USB audio"],
			audioStatus: { resolved_asrc: null, resolved_asrc_reason: "embedded" },
		});
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-auto-resolved"]'),
		).toBeNull();
	});

	it("STALE-VALUE GATE: an explicit pick shows NO Auto-resolved line despite a stale resolved_asrc", () => {
		const { container } = mount({
			config: { asrc: "USB audio" },
			audioSources: ["USB audio", "HDMI"],
			audioStatus: { resolved_asrc: "HDMI", resolved_asrc_reason: "hdmi" },
		});
		expect(
			container.querySelector('[data-testid="audio-source-auto-resolved"]'),
		).toBeNull();
	});

	it("renders the pending live-follow hint whenever pending is present (T7 slot)", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["USB audio", "HDMI"],
			audioStatus: {
				resolved_asrc: "USB audio",
				pending_audio_follow_asrc: "HDMI",
			},
		});
		expect(
			container.querySelector('[data-testid="audio-follow-pending"]'),
		).not.toBeNull();
	});

	it("renders NO pending hint when the pending slot is null/absent", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["USB audio", "HDMI"],
			audioStatus: { resolved_asrc: "USB audio" },
		});
		expect(
			container.querySelector('[data-testid="audio-follow-pending"]'),
		).toBeNull();
	});
});

describe("SourceSection — source×audio mixture matrix (M1–M6)", () => {
	it("M1: network + embedded cap → read-only embedded state, no ALSA picker", () => {
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
	});

	it("M2: network WITHOUT the cap → the ALSA picker REMAINS (legacy path)", () => {
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
	});

	it("M3: dual-USB Auto resolves to the cam's own audio → 'Auto → device'", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["RØDE Streamer Mic", "Elgato Wave:3"],
			audioStatus: { resolved_asrc: "RØDE Streamer Mic" },
		});
		const line = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-auto-resolved"]',
		);
		expect(line?.textContent).toContain("Auto \u2192 RØDE Streamer Mic");
	});

	it("M4: HDMI video → 'Auto → HDMI'", () => {
		const { container } = mount({
			config: { asrc: AUDIO_SOURCE_AUTO },
			audioSources: ["HDMI"],
			audioStatus: { resolved_asrc: "HDMI", resolved_asrc_reason: "hdmi" },
		});
		const line = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-auto-resolved"]',
		);
		expect(line?.textContent).toContain("Auto \u2192 HDMI");
	});

	it("M5: a disappeared selection renders the unavailable marker (config not mutated)", () => {
		const { container } = mount({
			audioSources: ["No audio", "Pipeline default"],
			selectedAudioSource: "USB audio",
		});
		const marker = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-unavailable"]',
		);
		expect(marker?.textContent).toContain("USB audio");
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("M6: test-pattern/virtual → pipeline default read-only", () => {
		const { container } = mount({ audioSources: ["Pipeline default"] });
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly?.textContent).toContain("Pipeline default");
	});
});
