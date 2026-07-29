// @vitest-environment jsdom
/**
 * Regression lock: the live bitrate hot-adjust control must show the CURRENT
 * authoritative bitrate every time it mounts — never the schema default.
 *
 * Switching destination swaps `<CurrentComponent />` in NavigationRenderer, so
 * LiveView is genuinely unmounted and remounted; `bitrateDraft` is component
 * `$state` seeded from `BITRATE_DEFAULT_MIN` and only re-derives from
 * `config.max_br` through an `$effect`. A Wave H drill reported the operator's
 * mid-stream bitrate change reverting on tab-return — the cached `config.max_br`
 * was stale because `streaming.setBitrate` persisted without publishing a
 * `config` echo (fixed backend-side). This locks the frontend half: whatever the
 * store holds at mount is what the control shows.
 */
import { BITRATE_DEFAULT_MIN } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ maxBr: 6000 as number | undefined }));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({
		relay_server: "fra",
		max_br: state.maxBr,
		pipeline: "hdmi",
	}),
	getIsStreaming: () => true,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getAudioLevel: () => undefined,
	getDevices: () => [],
	getActiveInput: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getCapabilities: () => undefined,
	getConfigChange: () => undefined,
	getNetif: () => ({}),
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	getStatus: () => ({}),
	getPipelines: () => ({ pipelines: {} }),
	getSources: () => undefined,
}));

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
	getStreamingStartFailure: () => undefined,
	getStreamingAttemptGeneration: () => 1,
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
	revertStreamingOptimismFailure: vi.fn(),
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

function draftOf(container: HTMLElement): string | null {
	return container
		.querySelector('[data-testid="live-cockpit"]')
		?.getAttribute("data-bitrate-draft") as string | null;
}

beforeEach(() => {
	state.maxBr = 6000;
});

describe("LiveView — live bitrate draft across remount", () => {
	it("seeds the draft from the authoritative config.max_br on first mount", () => {
		const { container } = render(LiveView);
		expect(draftOf(container)).toBe("6000");
	});

	it("re-seeds from the CURRENT config.max_br after a destination switch", () => {
		const first = render(LiveView);
		expect(draftOf(first.container)).toBe("6000");
		first.unmount();

		// The operator hot-adjusted to 9000 while away; the store now holds it.
		state.maxBr = 9000;

		const second = render(LiveView);
		expect(draftOf(second.container)).toBe("9000");
		expect(draftOf(second.container)).not.toBe(String(BITRATE_DEFAULT_MIN));
	});

	it("never leaves the schema default on screen when a bitrate is known", () => {
		state.maxBr = BITRATE_DEFAULT_MIN + 1500;
		const { container } = render(LiveView);
		expect(draftOf(container)).toBe(String(BITRATE_DEFAULT_MIN + 1500));
	});
});
