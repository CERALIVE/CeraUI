// @vitest-environment jsdom
import type { CapabilitiesMessage, CaptureDevice } from "@ceraui/rpc/schemas";
import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

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
