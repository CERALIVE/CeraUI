// @vitest-environment jsdom
/**
 * LiveView — idle/live cockpit split (Task 11).
 *
 * Locks the structural contract the plan pins: LiveView renders EXACTLY one
 * cockpit at a time, gated on the OPTIMISTIC view of streaming so the start
 * transition shows LiveCockpit without a flicker back through idle.
 *
 *   • isStreaming false, optimism idle → IdleCockpit only (no LiveCockpit);
 *   • optimism `starting` (isStreaming still false) → LiveCockpit visible
 *     (the no-flicker start transition);
 *   • isStreaming true → LiveCockpit only.
 *
 * The two cockpits are stubbed to their identifying testids so the switch is
 * asserted without mounting the GoLiveCard/SourceSection subtree.
 */
import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	isStreaming: false,
	optimismState: "idle" as "idle" | "starting" | "stopping",
}));

// LiveView statically imports `navElements` from `$lib/config`, which transitively
// pulls the full destination-view graph (incl. DevTools → pwa → window.matchMedia,
// absent in jsdom). Mock it to just the one export LiveView reads — navigateTo is
// lazy-imported at click time and never touched here.
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
	getIsStreaming: () => state.isStreaming,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
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
	getStreamingOptimismState: () => state.optimismState,
	getStreamingStopReason: () => undefined,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
}));

// Stub the two cockpits to their identifying testids.
vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/IdleCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/LiveCockpitStub.svelte")).default,
}));

// Stub the remaining direct children so the parent mounts without their graphs.
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
	state.isStreaming = false;
	state.optimismState = "idle";
});

describe("LiveView — idle/live cockpit split", () => {
	it("renders ONLY the IdleCockpit while idle (not streaming, optimism idle)", () => {
		const { container } = render(LiveView);
		expect(
			container.querySelector('[data-testid="idle-cockpit"]'),
			"IdleCockpit is mounted",
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="live-cockpit"]'),
			"LiveCockpit is NOT mounted while idle",
		).toBeNull();
	});

	it("shows the LiveCockpit during the optimistic `starting` transition (no flicker)", () => {
		state.optimismState = "starting"; // isStreaming still false
		const { container } = render(LiveView);
		expect(
			container.querySelector('[data-testid="live-cockpit"]'),
			"LiveCockpit is shown optimistically on start",
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="idle-cockpit"]'),
			"IdleCockpit is NOT mounted during the start transition",
		).toBeNull();
	});

	it("renders ONLY the LiveCockpit while streaming", () => {
		state.isStreaming = true;
		const { container } = render(LiveView);
		expect(
			container.querySelector('[data-testid="live-cockpit"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="idle-cockpit"]'),
		).toBeNull();
	});
});
