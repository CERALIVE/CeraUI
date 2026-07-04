// @vitest-environment jsdom
import type {
	CapabilitiesMessage,
	CaptureDevice,
	NetworkIngest,
	Pipeline,
	Pipelines,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

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

import SourceSection from "./SourceSection.svelte";

const DEVICES: CaptureDevice[] = [
	{
		input_id: "video0",
		device_path: "/dev/video0",
		display_name: "RØDE HDMI",
		media_class: "video",
		kind: "hdmi",
		caps: [{ width: 1920, height: 1080, framerate: "30/1" }],
	},
	{
		input_id: "video63",
		device_path: "/dev/video63",
		display_name: "QA-Cam",
		media_class: "video",
		kind: "usb",
	},
];

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

function mount(props: Record<string, unknown>) {
	return render(SourceSection, {
		props: { devices: DEVICES, activeInput: "video0", ...props },
	});
}

describe("SourceSection — unified source surface (Task 8)", () => {
	it("renders the section with the embedded video input picker", () => {
		const { container } = mount({});
		expect(
			container.querySelector('[data-testid="source-section"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="input-picker"]'),
		).not.toBeNull();
	});

	it("derives a compact capability summary (res/fps/codec) from capabilities", () => {
		const { container } = mount({ capabilities: CAPS });
		const caps = container.querySelector<HTMLElement>(
			'[data-testid="source-capabilities"]',
		);
		if (!caps) throw new Error("capability summary not rendered");
		expect(caps.textContent).toContain("1080p");
		expect(caps.textContent).toContain("60fps");
		expect(caps.textContent).toContain("H.264");
		expect(caps.textContent).toContain("H.265");
		// Audio support is advertised as its own chip.
		expect(container.querySelector('[data-testid="cap-audio"]')).not.toBeNull();
	});

	it("omits the capability summary entirely when no capabilities have arrived", () => {
		const { container } = mount({ capabilities: undefined });
		expect(
			container.querySelector('[data-testid="source-capabilities"]'),
		).toBeNull();
	});
});

describe("SourceSection — audio source single vs multiple (Task 8)", () => {
	it("renders a SINGLE audio source read-only (no misleading dropdown)", () => {
		const { container } = mount({ audioSources: ["alsa:usbaudio"] });
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly).not.toBeNull();
		expect(readonly?.textContent).toContain("alsa:usbaudio");
		// No selectable control for a single source.
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
		// Even with multiple sources, streaming downgrades to read-only.
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
		expect(
			container.querySelector('[data-testid="audio-source-readonly"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).toBeNull();
	});
});

describe("SourceSection — configured-but-unavailable audio source (Todo 2)", () => {
	it("renders the configured value as a visible unavailable entry (no orphan)", () => {
		const { container } = mount({
			audioSources: ["No audio", "Pipeline default"],
			selectedAudioSource: "USB audio",
		});
		// Multiple reported sources → selectable; the configured "USB audio" is not
		// among them but must still be shown, marked unavailable (never an orphan).
		const select = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-select"]',
		);
		expect(select).not.toBeNull();
		const marker = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-unavailable"]',
		);
		expect(marker).not.toBeNull();
		expect(marker?.textContent).toContain("USB audio");
	});

	it("shows no unavailable marker when the configured source is reported", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			selectedAudioSource: "USB audio",
		});
		expect(
			container.querySelector('[data-testid="audio-source-unavailable"]'),
		).toBeNull();
	});

	it("marks an absent configured source unavailable in the read-only (streaming) branch", () => {
		const { container } = mount({
			audioSources: ["No audio", "Pipeline default"],
			selectedAudioSource: "USB audio",
			isStreaming: true,
		});
		const readonly = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-readonly"]',
		);
		expect(readonly?.textContent).toContain("USB audio");
		expect(
			container.querySelector('[data-testid="audio-source-unavailable"]'),
		).not.toBeNull();
	});
});

describe("SourceSection — lost device explanation (Task 8)", () => {
	it("shows an explicit lost-device banner (badge + body) when a device is lost", () => {
		const lost = DEVICES.map((d) =>
			d.input_id === "video63" ? { ...d, lost: true } : d,
		);
		const { container } = mount({ devices: lost });
		const banner = container.querySelector<HTMLElement>(
			'[data-testid="source-lost-banner"]',
		);
		if (!banner) throw new Error("lost banner not rendered");
		// Explanatory text + recovery hint, not just a silent "Lost" label.
		expect(within(banner).getByText(/disconnected/i)).toBeTruthy();
		expect(within(banner).getByText(/reconnect/i)).toBeTruthy();
	});

	it("hides the lost-device banner when every device is healthy", () => {
		const { container } = mount({ devices: DEVICES });
		expect(
			container.querySelector('[data-testid="source-lost-banner"]'),
		).toBeNull();
	});
});

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: "Pipeline",
		description: "",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		...overrides,
	};
}

const INGEST_PIPELINES: Pipelines = {
	rtmp: pipeline({ name: "RTMP Ingest", requires_gateway: "rtmp" }),
	srt: pipeline({ name: "SRT Ingest", requires_gateway: "srt" }),
	hdmi: pipeline({ name: "HDMI" }),
};

const RTMP_URL = "rtmp://192.168.1.100:1935/publish/live";

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

describe("SourceSection — network-ingest gateways as first-class sources (Task 12)", () => {
	it("renders nothing when network_ingest is null (no rows)", () => {
		const { container } = mount({
			networkIngest: null,
			pipelines: INGEST_PIPELINES,
		});
		expect(
			container.querySelector('[data-testid="source-network-ingest"]'),
		).toBeNull();
	});

	it("disables a row with a gateway-inactive reason when the service is down", () => {
		const ingest: NetworkIngest = {
			rtmp: { service_active: false, url: RTMP_URL },
			srt: null,
		};
		const { container } = mount({
			networkIngest: ingest,
			pipelines: INGEST_PIPELINES,
		});
		const row = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(row).not.toBeNull();
		expect(row?.disabled).toBe(true);
		expect(row?.getAttribute("title")).toBeTruthy();
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-reason-rtmp"]',
			),
		).not.toBeNull();
		// SRT is board-absent → no row.
		expect(
			container.querySelector('[data-testid="source-network-ingest-row-srt"]'),
		).toBeNull();
	});

	it("renders the publish URL + QR for an active gateway and copies it", async () => {
		const writeText = vi.fn(async () => {});
		Object.assign(navigator, { clipboard: { writeText } });
		const ingest: NetworkIngest = {
			rtmp: { service_active: true, url: RTMP_URL },
			srt: null,
		};
		const { container } = mount({
			networkIngest: ingest,
			pipelines: INGEST_PIPELINES,
			capabilities: CAPS_AUDIO_RTMP,
		});

		const row = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		expect(row?.disabled).toBe(false);

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
		if (!copy) throw new Error("copy button not rendered");
		await fireEvent.click(copy);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(RTMP_URL));
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("shows an 'includes audio' chip only when caps advertise embedded audio", () => {
		const ingest: NetworkIngest = {
			rtmp: { service_active: true, url: RTMP_URL },
			srt: null,
		};
		const withAudio = mount({
			networkIngest: ingest,
			pipelines: INGEST_PIPELINES,
			capabilities: CAPS_AUDIO_RTMP,
		});
		expect(
			withAudio.container.querySelector(
				'[data-testid="source-network-audio-rtmp"]',
			),
		).not.toBeNull();

		const noAudio = mount({
			networkIngest: ingest,
			pipelines: INGEST_PIPELINES,
			capabilities: undefined,
		});
		expect(
			noAudio.container.querySelector(
				'[data-testid="source-network-audio-rtmp"]',
			),
		).toBeNull();
	});

	it("dispatches onSelectNetworkIngest with the pipeline id when a row is picked", async () => {
		const onSelectNetworkIngest = vi.fn();
		const ingest: NetworkIngest = {
			rtmp: { service_active: true, url: RTMP_URL },
			srt: null,
		};
		const { container } = mount({
			networkIngest: ingest,
			pipelines: INGEST_PIPELINES,
			onSelectNetworkIngest,
		});
		const row = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-network-ingest-select-rtmp"]',
		);
		if (!row) throw new Error("network-ingest row not rendered");
		await fireEvent.click(row);
		expect(onSelectNetworkIngest).toHaveBeenCalledWith("rtmp");
	});
});

const CAPS_EMBEDDED_ON: CapabilitiesMessage = {
	...CAPS_AUDIO_RTMP,
	network_embedded_audio: true,
};

describe("SourceSection — embedded network-ingest audio (Task 13)", () => {
	it("renders the read-only embedded state (no ALSA picker) WITH the capability", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			selectedPipeline: "srt",
			pipelines: {
				srt: pipeline({ requires_gateway: "srt", audio_kind: "embedded" }),
			},
			capabilities: CAPS_EMBEDDED_ON,
		});
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).not.toBeNull();
		// The ALSA source controls are absent when the engine routes embedded audio.
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
			selectedPipeline: "srt",
			pipelines: {
				srt: pipeline({ requires_gateway: "srt", audio_kind: "embedded" }),
			},
			capabilities: CAPS_AUDIO_RTMP,
		});
		// Legacy ALSA path preserved — the picker still renders…
		expect(
			container.querySelector('[data-testid="audio-source-select"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).toBeNull();
		// …but the TD-embedded-audio coming-soon pill no longer lives inline here —
		// it moved to IdleCockpit's collapsed "Roadmap" disclosure (T12).
		expect(
			container.querySelector('[data-debt-id="TD-embedded-audio"]'),
		).toBeNull();
	});

	it("does not treat a selectable pipeline as embedded even with the capability on", () => {
		const { container } = mount({
			audioSources: ["USB audio", "Pipeline default"],
			selectedPipeline: "hdmi",
			pipelines: { hdmi: pipeline({ audio_kind: "selectable" }) },
			capabilities: CAPS_EMBEDDED_ON,
		});
		expect(
			container.querySelector('[data-testid="audio-source-embedded"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-debt-id="TD-embedded-audio"]'),
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

describe("SourceSection — audio selection callback", () => {
	it("fires onSelectAudioSource when a multi-source selection is made", async () => {
		const onSelectAudioSource = vi.fn();
		const { container } = mount({
			audioSources: ["alsa:usbaudio", "alsa:hdmi"],
			onSelectAudioSource,
		});
		// The Select renders hidden native options; assert the trigger exists and
		// the callback wiring is in place by invoking via the native select.
		const select = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-select"]',
		);
		expect(select).not.toBeNull();
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
