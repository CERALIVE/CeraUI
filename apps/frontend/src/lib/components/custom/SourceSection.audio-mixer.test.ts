// @vitest-environment jsdom
/**
 * SourceSection's idle audio card with and without the engine's `audio_mix`
 * capability: without it the card is today's picker and meter; with it the
 * mixer sits under the picker and today's meter moves into the main input's
 * strip, so the card never shows the same bars twice.
 */
import type { CapabilitiesMessage, ConfigMessage } from "@ceraui/rpc/schemas";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => "data:image/png;qr"),
}));
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig: vi.fn(), setAudioMix: vi.fn() } },
	rpcClient: {},
}));

const feed = vi.hoisted(() => ({
	status: undefined as Record<string, unknown> | undefined,
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => undefined,
	getConfig: () => undefined,
	getStatus: () => feed.status,
	getSources: () => undefined,
	getIsConnected: () => true,
}));

import SourceSection from "./SourceSection.svelte";

beforeAll(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

afterEach(() => {
	cleanup();
	feed.status = undefined;
});

const AUDIO_SOURCES = [
	{ id: "usb-a", kind: "device", label: "RODE AI-Micro" },
	{ id: "usb-b", kind: "device", label: "Elgato Wave:3" },
];

const MIXING = {
	audio_mix: {
		max_inputs: 4,
		max_tracks: 4,
		gain_db_min: -60,
		gain_db_max: 12,
		delay_ms_max: 2000,
	},
} as unknown as CapabilitiesMessage;

function mount(
	capabilities: CapabilitiesMessage,
	status: Record<string, unknown> = {},
) {
	feed.status = {
		audio_sources: AUDIO_SOURCES,
		asrcs: ["usb-a", "usb-b"],
		...status,
	};
	return render(SourceSection, {
		props: {
			audioSources: ["usb-a", "usb-b"],
			audioSourceList: AUDIO_SOURCES,
			selectedAudioSource: "usb-a",
			config: { asrc: "usb-a", pipeline: "hdmi" } as unknown as ConfigMessage,
			capabilities,
			audioStatus: feed.status,
		},
	});
}

function byTestId(root: ParentNode, id: string): HTMLElement {
	const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	expect(el, `${id} renders`).not.toBeNull();
	return el as HTMLElement;
}

describe("SourceSection — the idle audio card and the mixer", () => {
	it("without audio_mix the card is today's: picker and meter, no mixer", () => {
		const { container } = mount({} as CapabilitiesMessage);
		const card = byTestId(container, "audio-card");
		const audio = byTestId(card, "source-audio");
		byTestId(audio, "audio-source-select");
		byTestId(audio, "live-audio-meter");
		expect(card.querySelector('[data-testid="audio-mixer"]')).toBeNull();
		expect(
			card.querySelectorAll('[data-testid="live-audio-meter"]'),
		).toHaveLength(1);
	});

	it("with audio_mix the mixer sits under the picker and carries the one meter", () => {
		const { container } = mount(MIXING);
		const card = byTestId(container, "audio-card");
		const audio = byTestId(card, "source-audio");
		const mixer = byTestId(card, "audio-mixer");
		expect(
			audio.compareDocumentPosition(mixer) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		byTestId(audio, "audio-source-select");
		const meters = card.querySelectorAll('[data-testid="live-audio-meter"]');
		expect(meters).toHaveLength(1);
		expect(
			byTestId(card, "audio-strip-usb-a").contains(meters[0] as Node),
		).toBe(true);
	});

	it("while a mix session runs, the picker is read-only and says why", () => {
		const { container } = mount(MIXING, { audio_mix_active: true });
		const audio = byTestId(container, "source-audio");
		expect(
			audio.querySelector('[data-testid="audio-source-select"]'),
		).toBeNull();
		byTestId(audio, "audio-source-readonly");
		expect(byTestId(audio, "audio-source-mix-locked").textContent).toContain(
			"This stream is mixing inputs. Stop it to change the main input.",
		);
	});
});
