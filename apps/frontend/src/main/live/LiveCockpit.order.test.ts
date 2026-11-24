// @vitest-environment jsdom
/**
 * LiveCockpit — the live order of the Live screen contract.
 *
 *   banners → program-desk (preview → live-summary-strip → live-source-switch
 *   → layout-controls) → audio-card → telemetry-card (telemetry strip, ingest
 *   stats) → live-bar (bitrate adjuster, Stop).
 *
 * `layout-controls` exists only while the engine advertises `composition`, and
 * `audio-card` only while it advertises `audio_mix`.
 */
import type {
	ActiveEncode,
	CapabilitiesMessage,
	ConfigMessage,
	LinkTelemetryMessage,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { COMPOSITION_FEATURE } from "@ceraui/rpc/schemas";
import { cleanup, render, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WIDE_DESKTOP_QUERY } from "$lib/layout";
import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import type { ActiveSummary } from "$lib/streaming/sourceSummary";

vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./PreviewEncodeControl.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./CompositionCard.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));

import LiveCockpit from "./LiveCockpit.svelte";

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

beforeAll(() => {
	// bits-ui's Slider (BitrateAdjuster) installs a ResizeObserver, absent in jsdom.
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
});

const SUMMARY: ActiveSummary = {
	live: true,
	source: "HDMI Capture",
	resolution: "1080p",
	framerate: 60,
	codec: "H.265",
	inputCodec: undefined,
	passthrough: undefined,
	transport: "SRTLA",
};

function capture(id: string, displayName: string) {
	return {
		origin: "capture",
		id,
		pipelineId: "hdmi",
		kind: "hdmi",
		displayName,
		devicePath: `/dev/${id}`,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
	};
}

// Two captures with the first one on air: the live source switch renders.
const SOURCES = {
	hardware: "rk3588",
	sources: [capture("cam-a", "Camera A"), capture("cam-b", "Camera B")],
} as unknown as SourcesMessage;
const CONFIG = { source: "cam-a" } as unknown as ConfigMessage;
const ACTIVE_ENCODE = { active_input: "cam-a" } as unknown as ActiveEncode;

// Stale sender observations still lead the cards column.
const LINKS_DOWN: LinkTelemetryMessage = {
	links: [
		{
			conn_id: "0",
			iface: "eth0",
			stale: true,
			rtt_ms: 15,
			nak_count: 0,
			weight_percent: 100,
		},
	],
};

function cockpit(capabilities?: CapabilitiesMessage) {
	return render(LiveCockpit, { props: cockpitProps(capabilities) });
}

function cockpitProps(capabilities?: CapabilitiesMessage) {
	return {
		liveSummary: SUMMARY,
		sources: SOURCES,
		config: CONFIG,
		activeEncode: ACTIVE_ENCODE,
		activeInput: "cam-a",
		onSwitch: () => {},
		bitrate: "6 Mbps",
		bitrateDraft: 6000,
		bitrateLabel: "6 Mbps",
		bitrateMin: 500,
		bitrateMax: 12000,
		sliderMin: 1000,
		sliderMax: 9000,
		step: 250,
		onStep: () => {},
		onSliderChange: () => {},
		onSliderCommit: () => {},
		telemetry: LINKS_DOWN,
		isStreaming: true,
		optimismState: "streaming" as StreamingOptimismState,
		onStop: () => {},
		capabilities,
	};
}

function byTestId(root: ParentNode, id: string): HTMLElement {
	const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	expect(el, `${id} renders`).not.toBeNull();
	return el as HTMLElement;
}

function expectInOrder(
	elements: readonly HTMLElement[],
	labels: readonly string[],
): void {
	for (let i = 0; i < elements.length - 1; i++) {
		const current = elements[i] as HTMLElement;
		const next = elements[i + 1] as HTMLElement;
		expect(
			current.compareDocumentPosition(next) & FOLLOWING,
			`${labels[i]} precedes ${labels[i + 1]}`,
		).toBeTruthy();
	}
}

const COMPOSING = {
	features: [COMPOSITION_FEATURE],
} as unknown as CapabilitiesMessage;

const MIXING = {
	features: [COMPOSITION_FEATURE],
	audio_mix: {
		max_inputs: 4,
		max_tracks: 4,
		gain_db_min: -60,
		gain_db_max: 12,
		delay_ms_max: 2000,
	},
} as unknown as CapabilitiesMessage;

describe("LiveCockpit — live order", () => {
	it("mounts the stream glance only below desktop width", async () => {
		const viewport = Object.assign(new EventTarget(), {
			matches: true,
		});
		vi.stubGlobal("matchMedia", (query: string) =>
			query === WIDE_DESKTOP_QUERY
				? viewport
				: Object.assign(new EventTarget(), { matches: false }),
		);
		try {
			const { container } = cockpit(COMPOSING);
			const glance = () => container.querySelector("[data-live-glance]");
			expect(glance()).toBeNull();

			viewport.matches = false;
			viewport.dispatchEvent(new Event("change"));
			await waitFor(() => expect(glance()).not.toBeNull());

			viewport.matches = true;
			viewport.dispatchEvent(new Event("change"));
			await waitFor(() => expect(glance()).toBeNull());
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("orders banners, program-desk, telemetry-card, live-bar", () => {
		const { container } = cockpit(COMPOSING);
		const root = byTestId(container, "live-cockpit");

		const order = [
			"link-observation-lost-banner",
			"program-desk",
			"telemetry-card",
			"live-bar",
		];
		expectInOrder(
			order.map((id) => byTestId(root, id)),
			order,
		);
	});

	it("the desk holds the preview, the summary, the source switch, then layout-controls", () => {
		const { container } = cockpit(COMPOSING);
		const desk = byTestId(container, "program-desk");

		const order = [
			"preview-disclosure",
			"live-summary-strip",
			"live-source-switch",
			"layout-controls",
		];
		expectInOrder(
			order.map((id) => byTestId(desk, id)),
			order,
		);
	});

	it("the telemetry card holds the telemetry strip and the ingest stats", () => {
		const { container } = cockpit(COMPOSING);
		const card = byTestId(container, "telemetry-card");

		byTestId(card, "telemetry-bitrate");
		byTestId(card, "ingest-stats");
	});

	it("the live bar holds the bitrate control and Stop", () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		try {
			const { container } = cockpit(COMPOSING);
			const bar = byTestId(container, "live-bar");

			within(bar).getByRole("slider");
			within(bar).getByRole("button", { name: /stop stream/i });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("puts the audio card after program-desk and before telemetry-card when the engine mixes audio", () => {
		const { container } = cockpit(MIXING);
		const root = byTestId(container, "live-cockpit");

		const order = ["program-desk", "audio-card", "telemetry-card", "live-bar"];
		expectInOrder(
			order.map((id) => byTestId(root, id)),
			order,
		);
		byTestId(byTestId(root, "audio-card"), "audio-mixer");
		expect(
			byTestId(root, "program-desk").contains(byTestId(root, "audio-card")),
		).toBe(false);
	});

	it("renders no audio-card without audio_mix", () => {
		const { container } = cockpit(COMPOSING);
		expect(container.querySelector('[data-testid="audio-card"]')).toBeNull();
		expect(container.querySelector('[data-testid="audio-mixer"]')).toBeNull();
	});

	it("renders no audio-card in the post-stream summary window", () => {
		const { container } = render(LiveCockpit, {
			props: { ...cockpitProps(MIXING), isStreaming: false, summaryMode: true },
		});
		expect(container.querySelector('[data-testid="audio-card"]')).toBeNull();
	});

	it("renders no layout-controls without the composition feature", () => {
		const { container } = cockpit(undefined);
		expect(
			container.querySelector('[data-testid="layout-controls"]'),
		).toBeNull();
	});
});
