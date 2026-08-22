// @vitest-environment jsdom
import type { AudioSource } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

// jsdom implements no Pointer Capture API, and bits-ui's select calls it on the
// very first `pointerdown` — so without these the dropdown can never open here.
beforeAll(() => {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= () => false;
	proto.setPointerCapture ??= () => {};
	proto.releasePointerCapture ??= () => {};
	proto.scrollIntoView ??= () => {};
});

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

const setConfig = vi.hoisted(() =>
	vi.fn(async () => ({ success: true, applied: {} }) as unknown),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => undefined,
	getConfig: () => undefined,
}));

import SourceSection from "./SourceSection.svelte";

const MIC_ID = "bt:AA_BB_CC_11_22_33";
const USB_ID = "usbaudio";

function btMic(overrides: Partial<AudioSource> = {}): AudioSource {
	return {
		id: MIC_ID,
		kind: "device",
		label: "Jabra Talk 45",
		transport: "bluetooth",
		pcm_spec: "bluealsa:DEV=AA:BB:CC:11:22:33,PROFILE=sco",
		...overrides,
	};
}

const usbCard: AudioSource = {
	id: USB_ID,
	kind: "device",
	label: "USB audio",
	transport: "usb",
};

function mount(props: Record<string, unknown> = {}) {
	return render(SourceSection, { props });
}

function mountPicker(
	entries: AudioSource[],
	extra: Record<string, unknown> = {},
) {
	return mount({
		audioSources: entries.map((e) => e.id),
		audioSourceList: entries,
		selectedAudioSource: entries[0]?.id,
		...extra,
	});
}

describe("a Bluetooth microphone row", () => {
	it("renders the External badge and its NEGOTIATED quality, never a raw param", () => {
		const { container } = mountPicker([
			btMic({ quality: { codec: "msbc", sample_rate_hz: 16000, channels: 1 } }),
			usbCard,
		]);

		expect(
			container.querySelector('[data-testid="audio-source-external"]'),
		).not.toBeNull();

		const chip = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-quality"]',
		);
		expect(chip?.dataset.quality).toBe("negotiated");
		expect(chip?.textContent?.trim()).toBe("16 kHz mono");
		// The chip is param-interpolated, so a call that forgot its params would
		// render "undefined kHz mono" — a plausible-looking, false reading.
		expect(chip?.textContent).not.toContain("undefined");
		expect(chip?.textContent).not.toContain("{khz}");
	});

	it("renders narrowband CVSD as its real 8 kHz rate", () => {
		const { container } = mountPicker([
			btMic({ quality: { codec: "cvsd", sample_rate_hz: 8000, channels: 1 } }),
			usbCard,
		]);

		expect(
			container
				.querySelector('[data-testid="audio-source-quality"]')
				?.textContent?.trim(),
		).toBe("8 kHz mono");
	});

	it("falls back to the honest CEILING when the device reported no codec", () => {
		const { container } = mountPicker([btMic(), usbCard]);

		const chip = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-quality"]',
		);
		expect(chip?.dataset.quality).toBe("ceiling");
		expect(chip?.textContent?.trim()).toBe("Up to 16 kHz mono");
	});

	it("gives an ordinary ALSA card no quality chip at all", () => {
		const { container } = mountPicker([usbCard, btMic()], {
			selectedAudioSource: USB_ID,
		});

		expect(
			container.querySelector('[data-testid="audio-source-quality"]'),
		).toBeNull();
	});
});

describe("the engine feature gate", () => {
	it("keeps a gated row LISTED, disabled, and says why", async () => {
		const { container, findByTestId } = mountPicker(
			[usbCard, btMic({ unavailable_reason: "engine_update_required" })],
			{ selectedAudioSource: USB_ID },
		);

		const trigger = container.querySelector<HTMLElement>(
			'[data-testid="audio-source-select"]',
		);
		if (trigger === null) throw new Error("audio-source-select did not render");
		// bits-ui opens on the pointer sequence, not a synthetic `.click()`.
		await fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
		await fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });

		const blocked = await findByTestId(`audio-option-blocked-${MIC_ID}`);
		expect(blocked.textContent?.trim()).toBe("Engine update required");

		const option = blocked.closest("[role='option']");
		expect(option?.getAttribute("aria-disabled")).toBe("true");
		expect(option?.getAttribute("title")).toContain("too old to open it");
	});
});

describe("a live audio switch to or from Bluetooth", () => {
	it("is refused on screen while streaming, rather than left to a failed attempt", () => {
		const { container } = mount({
			audioSources: [MIC_ID, USB_ID],
			audioSourceList: [btMic(), usbCard],
			selectedAudioSource: MIC_ID,
			isStreaming: true,
		});

		expect(
			container.querySelector('[data-testid="audio-bluetooth-live-switch"]')
				?.textContent,
		).toContain("only be chosen before you go live");
	});

	it("says nothing about a live switch for an ordinary card", () => {
		const { container } = mount({
			audioSources: [MIC_ID, USB_ID],
			audioSourceList: [btMic(), usbCard],
			selectedAudioSource: USB_ID,
			isStreaming: true,
		});

		expect(
			container.querySelector('[data-testid="audio-bluetooth-live-switch"]'),
		).toBeNull();
	});

	it("says nothing while idle — the pick is legal before the stream starts", () => {
		const { container } = mountPicker([btMic(), usbCard]);

		expect(
			container.querySelector('[data-testid="audio-bluetooth-live-switch"]'),
		).toBeNull();
	});
});
