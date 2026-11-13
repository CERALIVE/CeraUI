// @vitest-environment jsdom
/**
 * LiveCockpit — the live order of the Live screen contract.
 *
 *   banners → program-desk (preview → live-summary-strip → live-source-switch
 *   → layout-controls) → telemetry-card (telemetry strip, ingest stats) →
 *   live-bar (bitrate adjuster, Stop).
 *
 * `layout-controls` exists only while the engine advertises `composition`.
 */
import type {
	ActiveEncode,
	CapabilitiesMessage,
	ConfigMessage,
	LinkTelemetryMessage,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { COMPOSITION_FEATURE } from "@ceraui/rpc/schemas";
import { cleanup, render, within } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

// Every link stale while one exists: the all-links-down banner shows.
const LINKS_DOWN = {
	links: [{ id: "eth0", stale: true }],
} as unknown as LinkTelemetryMessage;

function cockpit(capabilities?: CapabilitiesMessage) {
	return render(LiveCockpit, {
		props: {
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
		},
	});
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

describe("LiveCockpit — live order", () => {
	it("orders banners, program-desk, telemetry-card, live-bar", () => {
		const { container } = cockpit(COMPOSING);
		const root = byTestId(container, "live-cockpit");

		const order = [
			"all-links-down-banner",
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
		const { container } = cockpit(COMPOSING);
		const bar = byTestId(container, "live-bar");

		within(bar).getByRole("slider");
		within(bar).getByRole("button", { name: /stop stream/i });
	});

	it("renders no layout-controls without the composition feature", () => {
		const { container } = cockpit(undefined);
		expect(
			container.querySelector('[data-testid="layout-controls"]'),
		).toBeNull();
	});
});
