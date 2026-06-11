// @vitest-environment jsdom
import type { CaptureDevice, Pipeline } from "@ceraui/rpc/schemas";
import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import InputPicker from "./InputPicker.svelte";

const PIPELINES: Record<string, Pipeline> = {
	hdmi: {
		name: "HDMI Capture",
		description: "HDMI input",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
	},
	test: {
		name: "Test Pattern",
		description: "Synthetic test source",
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
	},
};

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
	{
		input_id: "audio:usbaudio",
		device_path: "alsa:usbaudio",
		display_name: "USB audio",
		media_class: "audio",
		kind: "audio",
	},
];

// bits-ui Select mints non-deterministic ids; strip them so the legacy-picker
// snapshot is stable across renders.
function normalize(html: string): string {
	return html
		.replace(/bits-[A-Za-z0-9_-]+/g, "bits-x")
		.replace(/\s(aria-controls|aria-labelledby|aria-describedby)="[^"]*"/g, "");
}

describe("InputPicker — engine conditional (Task 34)", () => {
	it("ceracoder mode renders the legacy pipeline picker unchanged", () => {
		const { container } = render(InputPicker, {
			props: { engine: "ceracoder", pipelines: PIPELINES, source: "hdmi" },
		});
		const picker = container.querySelector<HTMLElement>(
			'[data-testid="input-picker"]',
		);
		expect(picker).not.toBeNull();
		// Legacy trigger preserved (id + role), hotplug UI absent.
		expect(picker?.querySelector("#encoder-source")).not.toBeNull();
		expect(picker?.querySelector("[data-switch-input]")).toBeNull();
		expect(normalize(picker?.outerHTML ?? "")).toMatchSnapshot();
	});

	it("cerastream mode renders the hotplug picker", () => {
		const { container } = render(InputPicker, {
			props: { engine: "cerastream", devices: DEVICES, activeInput: "video0" },
		});
		const picker = container.querySelector<HTMLElement>(
			'[data-testid="input-picker"]',
		);
		expect(picker).not.toBeNull();
		expect(picker?.querySelector("#encoder-source")).toBeNull();
		expect(picker?.textContent).toContain("QA-Cam");
		expect(picker?.textContent).toContain("USB audio");
		expect(picker?.outerHTML).toMatchSnapshot();
	});
});

describe("InputPicker — hotplug behaviour", () => {
	it("marks the active device and flags a lost device disabled", () => {
		const lost: CaptureDevice[] = DEVICES.map((d) =>
			d.input_id === "video63" ? { ...d, lost: true } : d,
		);
		const { container } = render(InputPicker, {
			props: {
				engine: "cerastream",
				devices: lost,
				activeInput: "video0",
				isStreaming: true,
			},
		});
		const active = container.querySelector<HTMLElement>(
			'[data-input-id="video0"]',
		);
		expect(active?.getAttribute("data-active")).toBe("true");

		const lostRow = container.querySelector<HTMLElement>(
			'[data-input-id="video63"]',
		);
		if (!lostRow) throw new Error("lost row not rendered");
		expect(lostRow.getAttribute("data-lost")).toBe("true");
		expect(within(lostRow).getByText(/lost/i)).toBeTruthy();
	});

	it("fires onSwitch for a healthy non-active device while streaming", async () => {
		const onSwitch = vi.fn();
		const { container } = render(InputPicker, {
			props: {
				engine: "cerastream",
				devices: DEVICES,
				activeInput: "video0",
				isStreaming: true,
				onSwitch,
			},
		});
		const switchBtn = container.querySelector<HTMLButtonElement>(
			'[data-switch-input="video63"]',
		);
		if (!switchBtn) throw new Error("switch button not rendered");
		await fireEvent.click(switchBtn);
		expect(onSwitch).toHaveBeenCalledWith("video63");
	});

	it("renders an empty state when no sources are present", () => {
		const { container } = render(InputPicker, {
			props: { engine: "cerastream", devices: [] },
		});
		const picker = container.querySelector<HTMLElement>(
			'[data-testid="input-picker"]',
		);
		expect(picker?.querySelector("[data-input-id]")).toBeNull();
		expect(picker?.textContent ?? "").toMatch(/no input sources/i);
	});
});
