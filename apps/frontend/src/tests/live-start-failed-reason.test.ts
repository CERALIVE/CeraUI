// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "../../../../packages/i18n/src/en/index";

const state = vi.hoisted(() => ({
	stopReason: undefined as string | undefined,
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("svelte-sonner", () => ({ toast: { error: toastError } }));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getAudioLevel: () => undefined,
	getDevices: () => [],
	getActiveInput: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getCapabilities: () => undefined,
	getNetif: () => ({}),
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	getStatus: () => ({}),
	getPipelines: () => ({ pipelines: {} }),
	getSources: () => undefined,
}));

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => state.stopReason,
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
	retryStopStreaming: vi.fn(),
}));

vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("./fixtures/IdleCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("./fixtures/LiveCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));

import LiveView from "../main/LiveView.svelte";

const startFailed = en.live.startFailed as Readonly<Record<string, string>>;

afterEach(() => {
	cleanup();
	state.stopReason = undefined;
	toastError.mockReset();
});

describe("LiveView start-failure output", () => {
	it.each([
		"audio_source_probe_failed",
		"audio_codec_unsupported_transport",
		"source_lost",
		"source_unavailable",
	])("shows the localized reason for %s", async (reason) => {
		state.stopReason = reason;

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(startFailed[reason]);
		expect(startFailed[reason]).not.toBe(startFailed.generic);
	});

	it("shows the generic message for an unknown reason", async () => {
		state.stopReason = "unknown_engine_failure";

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(startFailed.generic);
	});
});
