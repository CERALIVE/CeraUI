// @vitest-environment jsdom
/**
 * LiveView — the operator's Stop while the device cannot confirm the stream.
 *
 * The backend holds stream protection in `reconciling` / `stop_failed` and
 * refuses Start, updates and reboot until positive engine evidence or an
 * operator Stop arrives. With `is_streaming` false the Live view used to show
 * the idle cockpit, which has no Stop. These cases pin where the Stop now
 * appears, that it calls `streaming.stop`, and that every other state renders
 * exactly the cockpit it rendered before.
 */
import { fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamLifecycleFixture as fx } from "../tests/fixtures/reactive-stream-lifecycle.svelte";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: { streaming: { stop: vi.fn() } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { streamLifecycleFixture } = await import(
		"../tests/fixtures/reactive-stream-lifecycle.svelte"
	);
	return {
		getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
		getIsStreaming: () => streamLifecycleFixture.streaming,
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
		getStatus: () => ({ stream_lifecycle: streamLifecycleFixture.lifecycle }),
		getPipelines: () => ({ pipelines: {} }),
		getSources: () => undefined,
	};
});

vi.mock("$lib/rpc/streaming-optimism.svelte", async () => {
	const { streamLifecycleFixture } = await import(
		"../tests/fixtures/reactive-stream-lifecycle.svelte"
	);
	return {
		getStreamingOptimismState: () => streamLifecycleFixture.optimism,
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
		supersedeStartingOptimism: vi.fn(),
	};
});

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

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import {
	stopStreamingOptimism,
	supersedeStartingOptimism,
} from "$lib/rpc/streaming-optimism.svelte";

import LiveView from "./LiveView.svelte";

const select = (container: HTMLElement, id: string) =>
	container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
	vi.clearAllMocks();
	fx.reset();
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("LiveView — unconfirmed stream state offers Stop", () => {
	for (const lifecycle of ["reconciling", "stop_failed"] as const) {
		it(`${lifecycle} with is_streaming=false: band and Stop above the idle cockpit`, () => {
			fx.lifecycle = lifecycle;
			const { container } = render(LiveView);
			expect(select(container, "unconfirmed-stream-band")).not.toBeNull();
			expect(select(container, "unconfirmed-stream-stop")).not.toBeNull();
			expect(select(container, "idle-cockpit")).not.toBeNull();
			expect(select(container, "live-cockpit")).toBeNull();
		});
	}

	it("the band's Stop calls streaming.stop and leaves the optimism overlay alone", async () => {
		vi.mocked(rpc.streaming.stop).mockResolvedValueOnce({
			result: "stopped",
			success: true,
		} as never);
		fx.lifecycle = "reconciling";
		const { container } = render(LiveView);
		const button = select(container, "unconfirmed-stream-stop");
		if (!button) throw new Error("Stop not rendered");
		await fireEvent.click(button);
		expect(rpc.streaming.stop).toHaveBeenCalledTimes(1);
		expect(rpc.streaming.stop).toHaveBeenCalledWith();
		expect(stopStreamingOptimism).not.toHaveBeenCalled();
	});

	it("retracts the band when the device pushes idle", () => {
		fx.lifecycle = "stop_failed";
		const { container } = render(LiveView);
		expect(select(container, "unconfirmed-stream-band")).not.toBeNull();
		fx.lifecycle = "idle";
		flushSync();
		expect(select(container, "unconfirmed-stream-band")).toBeNull();
		expect(select(container, "idle-cockpit")).not.toBeNull();
	});

	it("shows Stop during the post-stream summary window, where the cockpit has none", () => {
		vi.useFakeTimers();
		try {
			fx.lifecycle = "streaming";
			fx.streaming = true;
			const { container } = render(LiveView);
			expect(select(container, "unconfirmed-stream-band")).toBeNull();
			// Engine loss: acknowledged stop to idle, then a silent reconcile.
			fx.streaming = false;
			fx.lifecycle = "reconciling";
			flushSync();
			expect(
				select(container, "live-cockpit")?.getAttribute("data-summary-mode"),
			).toBe("true");
			expect(select(container, "unconfirmed-stream-stop")).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	// FIX-16-C3: this cell used to sit in the negative matrix below ("live
	// cockpit, no band"). That encoded C2's mistaken assumption that the
	// optimistic live cockpit carries a Stop; it shows a disabled "Starting...".
	// The device's unconfirmed projection now shows the band AND settles the stale
	// local start (this file's optimism store is a stub, so the settle is
	// asserted as the call it makes; the real store is exercised in
	// LiveView.unconfirmed-real-reach.test.ts).
	it("reconciling with a stale local starting: band shown and the start optimism superseded", () => {
		fx.lifecycle = "reconciling";
		fx.optimism = "starting";
		const { container } = render(LiveView);
		expect(select(container, "unconfirmed-stream-band")).not.toBeNull();
		expect(select(container, "unconfirmed-stream-stop")).not.toBeNull();
		expect(supersedeStartingOptimism).toHaveBeenCalledWith(1);
	});
});

describe("LiveView — every other state renders the cockpit it rendered before", () => {
	const cases = [
		{
			lifecycle: undefined,
			streaming: false,
			optimism: "idle",
			cockpit: "idle-cockpit",
		},
		{
			lifecycle: "idle",
			streaming: false,
			optimism: "idle",
			cockpit: "idle-cockpit",
		},
		{
			lifecycle: "starting",
			streaming: false,
			optimism: "idle",
			cockpit: "idle-cockpit",
		},
		{
			lifecycle: "starting",
			streaming: false,
			optimism: "starting",
			cockpit: "live-cockpit",
		},
		{
			lifecycle: "streaming",
			streaming: true,
			optimism: "idle",
			cockpit: "live-cockpit",
		},
		{
			lifecycle: "reconfiguring",
			streaming: true,
			optimism: "idle",
			cockpit: "live-cockpit",
		},
		{
			lifecycle: "stopping",
			streaming: true,
			optimism: "stopping",
			cockpit: "live-cockpit",
		},
		{
			lifecycle: "stopping",
			streaming: false,
			optimism: "stopping",
			cockpit: "idle-cockpit",
		},
		{
			lifecycle: "reconciling",
			streaming: true,
			optimism: "idle",
			cockpit: "live-cockpit",
		},
		{
			lifecycle: "stop_failed",
			streaming: true,
			optimism: "idle",
			cockpit: "live-cockpit",
		},
	] as const;
	for (const c of cases) {
		it(`${c.lifecycle}|${c.streaming}|${c.optimism}: ${c.cockpit}, no band`, () => {
			fx.lifecycle = c.lifecycle;
			fx.streaming = c.streaming;
			fx.optimism = c.optimism;
			const { container } = render(LiveView);
			expect(select(container, "unconfirmed-stream-band")).toBeNull();
			expect(select(container, c.cockpit)).not.toBeNull();
			const other =
				c.cockpit === "idle-cockpit" ? "live-cockpit" : "idle-cockpit";
			expect(select(container, other)).toBeNull();
		});
	}
});
