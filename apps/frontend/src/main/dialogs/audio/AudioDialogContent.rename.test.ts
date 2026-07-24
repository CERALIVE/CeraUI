// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/svelte";
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
		canRenameAudioDevice: true,
		draftAlias: "",
		aliasMaxLength: 64,
		onAliasChange: vi.fn(),
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

describe("AudioDialogContent — audio-device rename (device-quality-wave2)", () => {
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

	it("surfaces the raw descriptor as a secondary detail line under the input", () => {
		const { container } = render(AudioDialogContent, { props: baseProps() });
		expect(q(container, "audio-device-hardware-detail")?.textContent).toContain(
			RODE_LONGNAME,
		);
	});

	it("renders the rename input seeded with the existing alias", () => {
		const { container } = render(AudioDialogContent, {
			props: baseProps({ draftAlias: "Camera A" }),
		});
		const input = q(container, "audio-device-rename-input") as HTMLInputElement;
		expect(input).not.toBeNull();
		expect(input.value).toBe("Camera A");
	});

	it("reports every keystroke through onAliasChange", async () => {
		const onAliasChange = vi.fn();
		const { container } = render(AudioDialogContent, {
			props: baseProps({ onAliasChange }),
		});
		const input = q(container, "audio-device-rename-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Presenter mic" } });
		expect(onAliasChange).toHaveBeenCalledWith("Presenter mic");
	});

	it("caps the input at the schema max length", () => {
		const { container } = render(AudioDialogContent, {
			props: baseProps({ aliasMaxLength: 64 }),
		});
		const input = q(container, "audio-device-rename-input") as HTMLInputElement;
		expect(input.getAttribute("maxlength")).toBe("64");
	});

	it("hides the rename block for a source with no renameable hardware identity", () => {
		const { container } = render(AudioDialogContent, {
			props: baseProps({ canRenameAudioDevice: false }),
		});
		expect(q(container, "audio-device-rename")).toBeNull();
	});

	it("omits the detail line when the hardware name needed no cleaning", () => {
		const { container } = render(AudioDialogContent, {
			props: baseProps({
				activeAudioSourceLabel: "rockchip,hdmiin",
				activeAudioSourceDetail: undefined,
			}),
		});
		expect(q(container, "audio-device-hardware-detail")).toBeNull();
		expect(q(container, "audio-device-rename")).not.toBeNull();
	});
});
