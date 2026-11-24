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
import { describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({ asrc: "No audio" }));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({
		relay_server: "fra",
		max_br: 6000,
		pipeline: "rtmp",
		source: "rtmp",
		asrc: view.asrc,
	}),
	getIsStreaming: () => true,
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
}));

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
});
