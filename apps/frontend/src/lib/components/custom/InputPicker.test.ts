// @vitest-environment jsdom
import type { CaptureDevice } from "@ceraui/rpc/schemas";
import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import InputPicker from "./InputPicker.svelte";

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

describe("InputPicker — hotplug picker (Task 34)", () => {
	it("renders the hotplug picker with all device groups", () => {
		const { container } = render(InputPicker, {
			props: { devices: DEVICES, activeInput: "video0" },
		});
		const picker = container.querySelector<HTMLElement>(
			'[data-testid="input-picker"]',
		);
		expect(picker).not.toBeNull();
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

	it("gates the audio source: deferred affordance + no enabled Switch while flag is false", () => {
		const { container } = render(InputPicker, {
			props: {
				devices: DEVICES,
				activeInput: "video0",
				isStreaming: true,
				audioLiveSwitchEnabled: false,
			},
		});
		expect(
			container.querySelector('[data-switch-input="audio:usbaudio"]'),
		).toBeNull();
		const comingSoon = container.querySelector<HTMLElement>(
			'[data-audio-switch-deferred="audio:usbaudio"]',
		);
		if (!comingSoon) throw new Error("deferred affordance not rendered");
		expect(comingSoon.getAttribute("data-debt-id")).toBe(
			"TD-live-audio-switch",
		);
		expect(comingSoon.querySelector("button")).toBeNull();
		expect(comingSoon.textContent?.toLowerCase()).toContain("coming soon");
		expect(
			container.querySelector('[data-switch-input="video63"]'),
		).not.toBeNull();
	});

	it("never dispatches onSwitch for the audio source while the flag is false", async () => {
		const onSwitch = vi.fn();
		const { container } = render(InputPicker, {
			props: {
				devices: DEVICES,
				activeInput: "video0",
				isStreaming: true,
				audioLiveSwitchEnabled: false,
				onSwitch,
			},
		});
		const comingSoon = container.querySelector<HTMLElement>(
			'[data-audio-switch-deferred="audio:usbaudio"]',
		);
		expect(comingSoon?.querySelector("button")).toBeNull();
		if (comingSoon) await fireEvent.click(comingSoon);
		expect(onSwitch).not.toHaveBeenCalledWith("audio:usbaudio");
	});

	it("offers an enabled audio Switch once the capability flag is true", async () => {
		const onSwitch = vi.fn();
		const { container } = render(InputPicker, {
			props: {
				devices: DEVICES,
				activeInput: "video0",
				isStreaming: true,
				audioLiveSwitchEnabled: true,
				onSwitch,
			},
		});
		expect(
			container.querySelector('[data-audio-switch-deferred="audio:usbaudio"]'),
		).toBeNull();
		const switchBtn = container.querySelector<HTMLButtonElement>(
			'[data-switch-input="audio:usbaudio"]',
		);
		if (!switchBtn) throw new Error("audio switch button not rendered");
		expect(switchBtn.disabled).toBe(false);
		await fireEvent.click(switchBtn);
		expect(onSwitch).toHaveBeenCalledWith("audio:usbaudio");
	});

	it("renders an empty state when no sources are present", () => {
		const { container } = render(InputPicker, {
			props: { devices: [] },
		});
		const picker = container.querySelector<HTMLElement>(
			'[data-testid="input-picker"]',
		);
		expect(picker?.querySelector("[data-input-id]")).toBeNull();
		expect(picker?.textContent ?? "").toMatch(/no input sources/i);
	});
});
