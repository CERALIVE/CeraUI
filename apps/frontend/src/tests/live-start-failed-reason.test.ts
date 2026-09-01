// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "./helpers/catalog";

const state = vi.hoisted(() => ({
	stopReason: undefined as string | undefined,
	failure: undefined as
		| {
				class: string;
				phase: string;
				retriable: boolean;
				attemptId: string;
				message?: string;
				captureCause?: string;
		  }
		| undefined,
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
	getStreamingStopReason: () => state.stopReason,
	getStreamingStartFailure: () => state.failure,
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
	state.failure = undefined;
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

const startFailure = en.live.startFailure;

describe("LiveView typed start-failure rendering (Todo 29)", () => {
	it("renders the class message + retried-then-failed suffix for a retriable class", async () => {
		state.failure = {
			class: "engine_unavailable",
			phase: "connect",
			retriable: true,
			attemptId: "att_a",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.engine_unavailable} ${startFailure.retriedThenFailed}`,
		);
	});

	it("renders the class message + not-retriable suffix for a deterministic class", async () => {
		state.failure = {
			class: "start_invalid",
			phase: "params",
			retriable: false,
			attemptId: "att_b",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.start_invalid} ${startFailure.notRetriable}`,
		);
	});

	it("prefers the typed failure over a legacy stopReason (single toast)", async () => {
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_c",
		};
		state.stopReason = "source_lost";

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.notRetriable}`,
		);
	});

	// `capture_source_unavailable` is the one class whose copy is keyed by cause:
	// the class names the subsystem, the cause names the operator's next move, so
	// rendering the class alone would be a band nobody can act on.
	it.each([
		["negotiation_failed", false],
		["no_signal", false],
		["device_busy", true],
	] as const)(
		"renders the per-cause capture copy for %s",
		async (captureCause, retriable) => {
			state.failure = {
				class: "capture_source_unavailable",
				phase: "start-rpc",
				retriable,
				attemptId: `att_${captureCause}`,
				captureCause,
			};

			render(LiveView);
			await tick();

			const reason =
				startFailure.class.capture_source_unavailable[captureCause];
			const suffix = retriable
				? startFailure.retriedThenFailed
				: startFailure.notRetriable;
			expect(toastError).toHaveBeenCalledWith(`${reason} ${suffix}`);
			expect(reason).not.toBe(startFailed.generic);
		},
	);

	it("names the signal format and the camera-side fix, never the operator's settings", () => {
		const negotiation =
			startFailure.class.capture_source_unavailable.negotiation_failed;

		expect(negotiation.toLowerCase()).toContain("format");
		expect(negotiation.toLowerCase()).toContain("camera");
		expect(negotiation.toLowerCase()).not.toContain("check your settings");
	});

	// The engine's raw diagnostic still travels to the backend logger (and so to
	// Settings → System Logs); it must never reach the operator's primary toast.
	it("keeps the raw engine diagnostic out of the typed failure toast", async () => {
		state.failure = {
			class: "start_invalid",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_d",
			message:
				"invalid params: audio-device-unavailable: ALSA capture device 'hw:CARD=rockchiphdmiin' is busy or unavailable",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.start_invalid} ${startFailure.notRetriable}`,
		);
		const shown = String(toastError.mock.calls[0]?.[0] ?? "");
		expect(shown).not.toContain("invalid params");
		expect(shown).not.toContain("hw:CARD=");
		expect(shown).not.toContain("journalctl");
	});
});
