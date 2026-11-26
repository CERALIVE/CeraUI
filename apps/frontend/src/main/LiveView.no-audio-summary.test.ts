// @vitest-environment jsdom
/**
 * LiveView: the live summary's audio line for an explicit "No audio".
 *
 * An RTMP/SRT ingest carries its own sound, so the summary used to say
 * "Embedded audio" for it even when the operator chose "No audio", the one
 * choice that promises nothing is sent. The pick outranks the source: the line
 * says "No audio", while Auto on the same ingest still says "Embedded audio".
 */
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamingFlag } from "../tests/fixtures/reactive-streaming.svelte";

const view = vi.hoisted(() => ({
	asrc: "No audio",
	offActive: undefined as boolean | undefined,
}));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { streamingFlag } = await import(
		"../tests/fixtures/reactive-streaming.svelte"
	);
	return {
		getConfig: () => ({
			relay_server: "fra",
			max_br: 6000,
			pipeline: "rtmp",
			source: "rtmp",
			asrc: view.asrc,
		}),
		getIsStreaming: () => streamingFlag.value,
		getSensors: () => ({}),
		getLinkTelemetry: () => null,
		getAudioLevel: () => undefined,
		getDevices: () => [],
		getActiveInput: () => undefined,
		getConnectionState: () => "connected",
		getIsConnected: () => true,
		getCapabilities: () => ({ network_embedded_audio: true }),
		getConfigChange: () => undefined,
		getNetif: () => ({}),
		getRelays: () => undefined,
		getManagedIngestAccounts: () => [],
		// A leftover Auto broadcast still names the ingest's embedded audio.
		getStatus: () => ({
			asrcs: ["USB audio", "No audio", "Pipeline default"],
			resolved_asrc: null,
			resolved_asrc_reason: "embedded",
			audio_off_active: view.offActive,
		}),
		getPipelines: () => ({ pipelines: {} }),
		getSources: () => ({
			hardware: "rk3588",
			sources: [
				{
					origin: "network",
					id: "rtmp",
					pipelineId: "rtmp",
					labelKey: "settings.sources.rtmp",
					requiresGateway: "rtmp",
					url: "rtmp://192.168.1.100:1935/publish/live",
					modes: [],
					supportsAudio: true,
					supportsResolutionOverride: false,
					supportsFramerateOverride: false,
					audioKind: "embedded",
					available: true,
				},
			],
		}),
	};
});

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
	getStreamingStartFailure: () => undefined,
	getStreamingAttemptGeneration: () => 1,
	revertStreamingOptimismFailure: vi.fn(),
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
	retryStopStreaming: vi.fn(),
}));

vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/IdleCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/LiveCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));

import LiveView from "./LiveView.svelte";

beforeEach(() => {
	streamingFlag.value = true;
	view.asrc = "No audio";
	view.offActive = undefined;
});
afterEach(() => {
	streamingFlag.reset();
});

const audioOf = (container: HTMLElement) => {
	const cockpit = container.querySelector<HTMLElement>(
		'[data-testid="live-cockpit"]',
	);
	return {
		current: cockpit?.dataset.audioCurrent,
		embedded: cockpit?.dataset.audioEmbedded,
	};
};

describe("LiveView: live summary audio line on an ingest", () => {
	it.each([
		["No audio", "false", "No audio"],
		["Auto", "true", undefined],
	] as const)("asrc %s: embedded %s, current %s", (asrc, embedded, current) => {
		view.asrc = asrc;
		const { container } = render(LiveView);
		const cockpit = container.querySelector<HTMLElement>(
			'[data-testid="live-cockpit"]',
		);
		expect(cockpit?.dataset.audioEmbedded).toBe(embedded);
		if (current !== undefined)
			expect(cockpit?.dataset.audioCurrent).toBe(current);
	});

	it.each(["USB audio", "Auto", "Pipeline default"])(
		"a silent stream says No audio while %s is saved for the next Start, and Stop shows the saved pick again",
		(asrc) => {
			view.asrc = asrc;
			view.offActive = true;
			const { container } = render(LiveView);
			expect(audioOf(container)).toEqual({
				current: "No audio",
				embedded: "false",
			});

			streamingFlag.value = false;
			flushSync();
			expect(audioOf(container).current).not.toBe("No audio");
			expect(audioOf(container).embedded).toBe("true");
		},
	);

	it("No audio saved for the next Start is not claimed for an ingest whose own sound is on air", () => {
		view.offActive = false;
		const { container } = render(LiveView);
		expect(audioOf(container)).toEqual({
			current: undefined,
			embedded: "true",
		});
	});

	it("a stream that is not silent keeps naming its pick when No audio is not running", () => {
		view.asrc = "USB audio";
		view.offActive = false;
		const { container } = render(LiveView);
		expect(audioOf(container).current).toBe("USB audio");
	});
});
