// @vitest-environment jsdom
/**
 * EncoderDialog — coherence-contract pass (C7).
 *
 * Two behaviours locked here:
 *
 *  1. Save-time re-validation. `handleSave` re-checks the draft against the
 *     CURRENT offered axes set (the same derivations that drive each control's
 *     aria-invalid). A device unplug that shrinks the offered axes blocks save —
 *     the disabled primary button never fires `onSave`, and the resolved
 *     disabled-reason renders INLINE (`encoder-save-blocked`), never a toast.
 *
 *  2. Source-change re-seed. When `config.source` changes while the dialog is
 *     open, the seed effect (keyed on source id) re-seeds the draft from the NEW
 *     active config and surfaces a calm one-line note (`encoder-source-changed-note`).
 *     `config.source` is read through a reactive `.svelte.ts` seam so a
 *     `reactiveConfig.value = …; flushSync()` drives the real reactivity.
 */
import type { CaptureStreamSource, SourcesMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	reactiveConfig,
	reactiveSources,
} from "../../tests/fixtures/reactive-subscriptions.svelte";
import type { EncoderConfig } from "./EncoderDialog.svelte";
import EncoderDialog from "./EncoderDialog.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveConfig, reactiveSources } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getPipelines: () => ({ hardware: "rk3588", pipelines: {} }),
		getCapabilities: () => ({
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
		}),
		getDevices: () => undefined,
		getIsStreaming: () => false,
		getConfig: () => reactiveConfig.value,
		getSources: () => reactiveSources.value,
	};
});

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

// USB capture device driving 720p@[30,60] + 1080p@[30] — no 2160p rung.
const USB_SOURCE: CaptureStreamSource = {
	id: "usb-0",
	origin: "capture",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "USB Capture",
	devicePath: "/dev/video1",
	modes: [
		{ width: 1280, height: 720, framerates: [30, 60] },
		{ width: 1920, height: 1080, framerates: [30] },
	],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

// HDMI capture device driving 1080p@[30,60] + 2160p@[30].
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

function sourcesMessage(sources: SourcesMessage["sources"]): SourcesMessage {
	return { hardware: "rk3588", sources } as SourcesMessage;
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

function q(testid: string): HTMLElement | null {
	return document.body.querySelector(`[data-testid="${testid}"]`);
}

function saveButton(): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		(b) => b.textContent?.trim() === "Save",
	) as HTMLButtonElement | undefined;
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
	reactiveConfig.reset();
	reactiveSources.reset();
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

describe("EncoderDialog — save-time re-validation (C7)", () => {
	it("blocks save on a device-unplug-shrunken axes set + renders the inline reason", async () => {
		// The saved config selects a 2160p encode, but the active USB source only
		// offers 720p/1080p (a device swap shrank the axes) — save must block.
		reactiveSources.value = sourcesMessage([USB_SOURCE]);
		reactiveConfig.value = { source: "usb-0", pipeline: "libuvch264" } as never;

		const onSave = vi.fn();
		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ resolution: "2160p" }),
				onSave,
			},
		});
		flushSync();

		// The inline resolved disabled-reason is rendered (never a toast).
		const blocked = q("encoder-save-blocked");
		expect(blocked).not.toBeNull();
		expect(blocked?.textContent?.trim()).not.toBe("");

		// The Save button is disabled and clicking it does NOT invoke onSave.
		const button = saveButton();
		expect(button).toBeDefined();
		expect(button?.disabled).toBe(true);
		await fireEvent.click(button as HTMLButtonElement);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("allows save when the selection is within the offered axes (no inline reason)", async () => {
		reactiveSources.value = sourcesMessage([USB_SOURCE]);
		reactiveConfig.value = { source: "usb-0", pipeline: "libuvch264" } as never;

		const onSave = vi.fn();
		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig({ resolution: "1080p", framerate: 30 }),
				onSave,
			},
		});
		flushSync();

		expect(q("encoder-save-blocked")).toBeNull();
		const button = saveButton();
		expect(button?.disabled).toBe(false);
		await fireEvent.click(button as HTMLButtonElement);
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});

describe("EncoderDialog — source-change re-seed (C7)", () => {
	it("re-seeds the draft from the new active config and surfaces the note when config.source changes", () => {
		reactiveSources.value = sourcesMessage([HDMI_SOURCE, USB_SOURCE]);
		reactiveConfig.value = {
			source: "hdmi-0",
			pipeline: "hdmi",
			resolution: "1080p",
			framerate: 30,
		} as never;

		render(EncoderDialog, {
			props: { open: true, config: encoderConfig({ resolution: "1080p" }) },
		});
		flushSync();

		// No note before any source change; the draft reflects the seeded 1080p.
		expect(q("encoder-source-changed-note")).toBeNull();
		expect(q("axis-current")?.textContent).toContain("1080p");

		// The operator picks a new source in the Source section → config.source
		// changes with a 720p active config for the new input.
		reactiveConfig.value = {
			source: "usb-0",
			pipeline: "libuvch264",
			resolution: "720p",
			framerate: 30,
		} as never;
		flushSync();

		// The draft is re-seeded from the new active config and the note appears.
		expect(q("encoder-source-changed-note")).not.toBeNull();
		expect(q("axis-current")?.textContent).toContain("720p");
	});
});
