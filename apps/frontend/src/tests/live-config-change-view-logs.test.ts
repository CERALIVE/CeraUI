// @vitest-environment jsdom
/**
 * An encoder change the engine could not apply, for a reason the device did
 * not name, tells the operator to check System Logs; its toast carries View
 * logs. A named reason, or a change that went live, carries no action.
 */
import type { StreamingSetConfigOutput } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "./helpers/catalog";

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	dismiss: vi.fn(),
}));
const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);

vi.mock("svelte-sonner", () => ({ toast }));
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));
vi.mock("$lib/helpers/SystemHelper", () => ({
	startStreaming: vi.fn(),
	stopStreaming: vi.fn(),
}));
vi.mock("$lib/streaming/sources-view-model", () => ({
	pipelinesFromSources: () => ({ hdmi: {} }),
}));
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
	default: (await import("./fixtures/IdleCockpitEncoderStub.svelte")).default,
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
	default: (await import("./fixtures/EncoderDialogSaveStub.svelte")).default,
}));

import { VIEW_LOGS_TOAST_CLASS } from "../lib/device-logs/view-logs";
import LiveView from "../main/LiveView.svelte";

const phase = en.live.encoder.applyPhase;
const VIEW_LOGS = {
	action: { label: en.notifications.viewLogs, onClick: expect.any(Function) },
	class: VIEW_LOGS_TOAST_CLASS,
};

afterEach(() => {
	cleanup();
	setConfig.mockReset();
	for (const fn of Object.values(toast)) fn.mockReset();
});

async function saveWith(
	configChange: StreamingSetConfigOutput["configChange"],
) {
	setConfig.mockResolvedValue({ success: true, applied: {}, configChange });
	const view = render(LiveView);
	await fireEvent.click(view.getByTestId("open-encoder"));
	await fireEvent.click(await view.findByTestId("encoder-save"));
	await expect.poll(() => setConfig.mock.calls.length).toBe(1);
}

describe("LiveView: encoder apply outcome toasts", () => {
	it("offers View logs when a failed rollback's reason is unnamed", async () => {
		await saveWith({
			result: "rollback_failed",
			attemptId: "a1",
			reason: "alsa busy",
		});

		await expect
			.poll(() => toast.error.mock.calls[0])
			.toEqual([`${phase.rollbackFailed} ${phase.reasonUnknown}`, VIEW_LOGS]);
	});

	it("offers View logs when a reverted change's reason is unnamed", async () => {
		await saveWith({
			result: "reverted",
			attemptId: "a1",
			reason: "not_negotiated",
		});

		await expect
			.poll(() => toast.warning.mock.calls[0])
			.toEqual([`${phase.reverted} ${phase.reasonUnknown}`, VIEW_LOGS]);
	});

	it("offers nothing when the device named the reason", async () => {
		await saveWith({
			result: "reverted",
			attemptId: "a1",
			reason: "change_rejected",
		});

		await expect
			.poll(() => toast.warning.mock.calls[0]?.[0])
			.toBe(`${phase.reverted} ${phase.reasonRejected}`);
		expect(toast.warning.mock.calls[0]?.[1]).toBeUndefined();
	});

	it("offers nothing when the change went live", async () => {
		await saveWith({ result: "applied", attemptId: "a1" });

		await expect
			.poll(() => toast.success.mock.calls[0])
			.toEqual([phase.applied]);
	});
});
