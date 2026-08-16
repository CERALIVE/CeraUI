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

import { en } from "./helpers/catalog";

const CONFIGURED_KBPS = 5000;
const APPLIED_KBPS = 3000;

const state = vi.hoisted(() => ({
	engineBitrate: undefined as
		| { applied_kbps: number; ceiling_kbps: number }
		| null
		| undefined,
	linkTelemetry: null as {
		links: Array<Record<string, unknown>>;
		measured_bps?: number;
	} | null,
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
	getDeviceStats: () => undefined,
	getDevices: () => [],
	// The cockpit's ENCODER cell reads this through device-health-history, whose
	// lazy singleton also fills the temperature/load rings — hence getDeviceStats.
	getEncoderLoadSnapshot: () => undefined,
	getIsConnected: () => true,
	getIsStreaming: () => state.isStreaming,
	getLinkTelemetry: () => state.linkTelemetry,
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
	state.linkTelemetry = null;
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

		const limit = getByTestId("telemetry-bitrate-limit");
		expect(limit.textContent).toContain(`5 ${en.units.mbps}`);
		// Named, not a bare "/ 4.5 Mbps". An operator read the slash form as a
		// fraction and asked what the third number counted; every figure in this
		// card is a bitrate, so none of them may travel without its own label.
		expect(limit.textContent).toContain(en.hud.bitrateLimit);
		expect(limit.textContent).not.toContain("/");
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

// Every case above runs with NO srtla telemetry, which is exactly why the card
// could report the engine's setpoint under a "Bitrate" heading and look right.
// A board session proved it is not: the setpoint held a steady 4.1 Mbps for 30 s
// while the engine's own watchdog logged "frames-not-advancing" and nothing left
// the device. srtla_send measures the real thing; these tests pin that the
// measurement takes the headline and the setpoint is labelled honestly.
describe("live stats card — measured throughput vs the engine's target", () => {
	const MEASURED_KBPS = 2800;

	function withMeasured(bps: number) {
		state.engineBitrate = {
			applied_kbps: APPLIED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};
		state.linkTelemetry = {
			links: [
				{
					conn_id: "0",
					iface: "usb0",
					rtt_ms: 20,
					nak_count: 0,
					weight_percent: 100,
					bitrate_bps: bps,
					stale: false,
				},
			],
			measured_bps: bps,
		};
	}

	it("headlines the MEASURED figure, not the engine's setpoint", async () => {
		withMeasured(MEASURED_KBPS * 1000);

		const { getByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate").textContent?.trim()).toBe(
			`2.8 ${en.units.mbps}`,
		);
		// "Bitrate" cannot be the heading: the target and the ceiling beneath it are
		// bitrates too. The heading names WHICH ONE the big number is.
		expect(getByTestId("telemetry-bitrate-heading").textContent?.trim()).toBe(
			en.hud.bitrateSending,
		);
	});

	it("keeps the setpoint visible as labelled 'Target' context", async () => {
		withMeasured(MEASURED_KBPS * 1000);

		const { getByTestId } = await mount();

		const target = getByTestId("telemetry-bitrate-target");
		expect(target.textContent).toContain(en.hud.bitrateTarget);
		expect(target.textContent).toContain(`3 ${en.units.mbps}`);
	});

	it("reports a bond carrying NOTHING as 0, not as the 4.1 Mbps setpoint", async () => {
		state.engineBitrate = { applied_kbps: 4100, ceiling_kbps: 4500 };
		state.linkTelemetry = {
			links: [
				{
					conn_id: "0",
					iface: "usb0",
					rtt_ms: 20,
					nak_count: 0,
					weight_percent: 100,
					bitrate_bps: 0,
					stale: false,
				},
			],
			measured_bps: 0,
		};

		const { getByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate").textContent?.trim()).toBe(
			`0 ${en.units.kbps}`,
		);
		expect(getByTestId("telemetry-bitrate-target").textContent).toContain(
			`4.1 ${en.units.mbps}`,
		);
	});

	it("relabels the card 'Target' when no measurement exists, rather than lying", async () => {
		state.engineBitrate = {
			applied_kbps: APPLIED_KBPS,
			ceiling_kbps: CONFIGURED_KBPS,
		};
		state.linkTelemetry = null;

		const { getByTestId, queryByTestId } = await mount();

		expect(getByTestId("telemetry-bitrate-heading").textContent?.trim()).toBe(
			en.hud.bitrateTarget,
		);
		expect(queryByTestId("telemetry-bitrate-target")).toBeNull();
	});

	it("folds the MEASURED rate into the IngestStats session rollup", async () => {
		withMeasured(MEASURED_KBPS * 1000);

		const { getByTestId } = await mount();

		expect(
			getByTestId("ingest-stats-probe").getAttribute("data-bitrate-kbps"),
		).toBe(String(MEASURED_KBPS));
	});
});
