// @vitest-environment jsdom
/**
 * Regression lock: the live stats card must report the bitrate the engine is
 * ACTUALLY applying, not the ceiling the operator configured.
 *
 * Reported from the field — under adaptive bitrate the "BITRATE" stat beside
 * "TEMPERATURE" kept reading the configured value (it was wired straight to
 * `config.max_br`, the same number the Adjust-Bitrate selector edits), so a
 * protective reduction was invisible: the card showed the request, never the
 * result. The HUD had already been fixed for exactly this (`deriveBitrateReading`,
 * `hud-bitrate-ceiling.test.ts`); these tests pin the same truth onto the Live
 * cockpit's card and onto the session rollup IngestStats folds.
 *
 * The assertions run against the REAL StreamTelemetryStrip rendered by the REAL
 * LiveCockpit from LiveView's own wiring — a test aimed at the strip's props
 * would sit downstream of the defect and pass on the broken tree.
 */
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "../../../../packages/i18n/src/en/index";

const CONFIGURED_KBPS = 5000;
const APPLIED_KBPS = 3000;

const state = vi.hoisted(() => ({
	engineBitrate: undefined as
		| { applied_kbps: number; ceiling_kbps: number }
		| null
		| undefined,
	maxBr: 5000 as number | undefined,
	isStreaming: true,
}));

vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getActiveInput: () => undefined,
	getAudioLevel: () => undefined,
	getCapabilities: () => undefined,
	getConfig: () => ({ max_br: state.maxBr, pipeline: "hdmi" }),
	getConfigChange: () => undefined,
	getConnectionState: () => "connected",
	getDevices: () => [],
	getIsConnected: () => true,
	getIsStreaming: () => state.isStreaming,
	getLinkTelemetry: () => null,
	getManagedIngestAccounts: () => [],
	getNetif: () => ({}),
	getPipelines: () => ({ pipelines: {} }),
	getRelays: () => undefined,
	getSensors: () => ({}),
	getSources: () => undefined,
	getStatus: () => ({ engine_bitrate: state.engineBitrate }),
}));

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "streaming",
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

// Everything around the card is inert: LiveCockpit and StreamTelemetryStrip stay
// REAL so the assertion reads the operator's actual DOM.
vi.mock("$lib/components/custom/IngestStats.svelte", async () => ({
	default: (await import("./fixtures/IngestStatsProbe.svelte")).default,
}));
vi.mock("$main/live/BitrateAdjuster.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSourceSwitch.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveSummaryStrip.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/PreviewDisclosure.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/StreamControlButton.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("./fixtures/IdleCockpitStub.svelte")).default,
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

afterEach(() => {
	cleanup();
	state.engineBitrate = undefined;
	state.maxBr = CONFIGURED_KBPS;
	state.isStreaming = true;
});

async function mount() {
	const view = render(LiveView);
	await tick();
	return view;
}

describe("live stats card — applied vs configured bitrate", () => {
	it("shows the rate the engine APPLIED, not the configured ceiling", async () => {
		state.engineBitrate = {
			applied_kbps: APPLIED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};

		const { getByTestId } = await mount();

		const shown = getByTestId("telemetry-bitrate").textContent?.trim();
		expect(shown).toBe(`3 ${en.units.mbps}`);
		expect(shown).not.toBe(`5 ${en.units.mbps}`);
	});

	it("names the configured ceiling beside it while throttled", async () => {
		state.engineBitrate = {
			applied_kbps: APPLIED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};

		const { getByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate-limit").textContent).toContain(
			`5 ${en.units.mbps}`,
		);
	});

	it("shows no ceiling qualifier when the engine is running at its ceiling", async () => {
		state.engineBitrate = {
			applied_kbps: CONFIGURED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};

		const { getByTestId, queryByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate").textContent?.trim()).toBe(
			`5 ${en.units.mbps}`,
		);
		expect(queryByTestId("telemetry-bitrate-limit")).toBeNull();
	});

	it("falls back to the configured value when the engine reports no telemetry", async () => {
		// Pre-first-sample, or an engine build that predates `engine_bitrate`: the
		// card must never blank out, and absence is never rendered as throttling.
		state.engineBitrate = undefined;

		const { getByTestId, queryByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate").textContent?.trim()).toBe(
			`5 ${en.units.mbps}`,
		);
		expect(queryByTestId("telemetry-bitrate-limit")).toBeNull();
	});

	it("renders an em dash rather than NaN when nothing is known at all", async () => {
		state.engineBitrate = null;
		state.maxBr = undefined;

		const { getByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate").textContent?.trim()).toBe("—");
	});

	it("folds the APPLIED rate into the IngestStats session rollup", async () => {
		state.engineBitrate = {
			applied_kbps: APPLIED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};

		const { getByTestId } = await mount();

		expect(
			getByTestId("ingest-stats-probe").getAttribute("data-bitrate-kbps"),
		).toBe(String(APPLIED_KBPS));
	});
});
