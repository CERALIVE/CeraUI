// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import AudioDialogContent from "./AudioDialogContent.svelte";

const RODE_LONGNAME =
	"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed";

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		gateState: "enabled" as const,
		isStreaming: false,
		audioEmbeddedComingSoon: false,
		activeAudioSourceLabel: "RØDE HDMI to USB-C",
		activeAudioSourceDetail: RODE_LONGNAME,
		activeAudioSourceExternal: true,
		draftCodec: "aac" as const,
		codecOptions: { aac: { name: "AAC" } },
		codecHasSource: true,
		codecTriggerLabel: "AAC",
		isCodecAllowed: () => true,
		onCodecChange: vi.fn(),
		draftDelay: 0,
		delayMin: -2000,
		delayMax: 2000,
		delayStep: 5,
		onDelayChange: vi.fn(),
		...overrides,
	};
}

function q(container: HTMLElement, testId: string): HTMLElement | null {
	return container.querySelector(`[data-testid="${testId}"]`);
}

describe("AudioDialogContent — audio-device labels (device-quality-wave2)", () => {
	it("shows the CLEANED name as the primary label, never the raw longname", () => {
		const { container } = render(AudioDialogContent, { props: baseProps() });
		const active = q(container, "audio-source-active");
		expect(active?.textContent).toContain("RØDE HDMI to USB-C");
		expect(active?.textContent).not.toContain("usb-xhci-hcd");
		expect(active?.textContent).not.toContain("super speed");
	});

	it("keeps the raw bus path and speed reachable as a tooltip", () => {
		const { container } = render(AudioDialogContent, { props: baseProps() });
		expect(q(container, "audio-source-active")?.getAttribute("title")).toBe(
			RODE_LONGNAME,
		);
	});

	it("marks a USB-attached device with a read-only External badge", () => {
		const { container } = render(AudioDialogContent, { props: baseProps() });
		const badge = q(container, "audio-device-external");
		expect(badge).not.toBeNull();
		expect(badge?.textContent?.trim()).toBe("External");
		expect(badge?.tagName).toBe("SPAN");
	});

	it("omits the External badge for an onboard source", () => {
		const { container } = render(AudioDialogContent, {
			props: baseProps({
				activeAudioSourceLabel: "HDMI Input",
				activeAudioSourceDetail: "rockchip,hdmiin",
				activeAudioSourceExternal: false,
			}),
		});
		expect(q(container, "audio-device-external")).toBeNull();
		expect(q(container, "audio-source-active")?.textContent).toContain(
			"HDMI Input",
		);
	});

	it("renders NO rename affordance of any kind", () => {
		for (const external of [true, false]) {
			const { container } = render(AudioDialogContent, {
				props: baseProps({ activeAudioSourceExternal: external }),
			});
			expect(q(container, "audio-device-rename")).toBeNull();
			expect(q(container, "audio-device-rename-input")).toBeNull();
			// No free-text field anywhere in the dialog — the only inputs are the
			// delay control's number/range pair.
			for (const input of container.querySelectorAll("input")) {
				expect(["number", "range"]).toContain(input.type);
			}
		}
	});
});
