// @vitest-environment jsdom
/**
 * LiveView — source_preference field-lock discipline (F2 field-lock fix).
 *
 * `handleReorderSource` writes `config.source_preference` via `streaming.setConfig`
 * from the inline capture-row reorder affordance (rendered by SourceSection inside
 * IdleCockpit). The repo-wide rule (apps/frontend/AGENTS.md → "Applied-state
 * acknowledgement"): the field lock must release to `result.applied.source_preference`
 * — the order the BACKEND actually persisted — never the optimistic array the client
 * sent, and a failed/omitting setConfig must call `markFieldFailed`, never
 * `markFieldApplied` with a guessed order.
 *
 * The sibling `LiveView.test.ts` covers the idle/live cockpit switch with an inert
 * IdleCockpit stub. This file uses a stub that surfaces the `onReorderSource`
 * callback as a button, and mocks the field-sync store so the exact
 * `markFieldApplied` / `markFieldFailed` release-values are asserted.
 */
import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// Two video capture devices with a persisted preference order. Reordering 'cam-b'
// up over 'cam-a' produces next=['cam-b','cam-a'] — different from current, so the
// handler dispatches (the no-op guard does not fire).
const DEVICES = [
	{
		input_id: "cam-a",
		device_path: "/dev/video0",
		display_name: "Cam A",
		media_class: "video",
		kind: "hdmi",
	},
	{
		input_id: "cam-b",
		device_path: "/dev/video1",
		display_name: "Cam B",
		media_class: "video",
		kind: "uvc_h264",
	},
];

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ source_preference: ["cam-a", "cam-b"], max_br: 6000 }),
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getDevices: () => DEVICES,
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
	getStreamingStopReason: () => undefined,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
}));

// The source_preference RPC — its resolved shape drives the applied-check branch.
const setConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc", () => ({
	rpc: {
		streaming: {
			setConfig,
			setBitrate: vi.fn(),
			switchInput: vi.fn(),
			switchAudio: vi.fn(),
		},
	},
	rpcClient: {},
}));

// Spy the field-sync store so the EXACT release-value is asserted.
const beginFieldSync = vi.hoisted(() => vi.fn());
const markFieldApplying = vi.hoisted(() => vi.fn());
const markFieldApplied = vi.hoisted(() => vi.fn());
const markFieldFailed = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc/field-sync-state.svelte", () => ({
	beginFieldSync,
	markFieldApplying,
	markFieldApplied,
	markFieldFailed,
	getFieldState: () => "idle",
	isFieldApplying: () => false,
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: {
		error: toastError,
		success: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		dismiss: vi.fn(),
	},
}));

// IdleCockpit stub surfaces the reorder callback as a button; LiveCockpit + the
// remaining direct children are inert.
vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/IdleCockpitReorderStub.svelte"))
		.default,
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

async function clickReorder(container: HTMLElement): Promise<void> {
	const btn = container.querySelector<HTMLButtonElement>(
		'[data-testid="stub-reorder-cam-b-up"]',
	);
	if (!btn) throw new Error("reorder stub button not rendered");
	await fireEvent.click(btn);
	// Flush the awaited setConfig + the post-resolve applied-check microtasks.
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	setConfig.mockReset();
	beginFieldSync.mockReset();
	markFieldApplying.mockReset();
	markFieldApplied.mockReset();
	markFieldFailed.mockReset();
	toastError.mockClear();
});

describe("LiveView — source_preference lock releases to result.applied, never the optimistic order", () => {
	it("a REJECTED setConfig ({success:false}) calls markFieldFailed with the prior order, NOT markFieldApplied", async () => {
		setConfig.mockResolvedValue({ success: false, error: "boom" });
		const { container } = render(LiveView);

		await clickReorder(container);

		// The optimistic next order was sent…
		expect(setConfig).toHaveBeenCalledWith({
			source_preference: ["cam-b", "cam-a"],
		});
		// …but it must NEVER be released as an applied value.
		expect(markFieldApplied).not.toHaveBeenCalled();
		// The lock reverts to the prior authoritative order.
		expect(markFieldFailed).toHaveBeenCalledWith("source_preference", [
			"cam-a",
			"cam-b",
		]);
		expect(toastError).toHaveBeenCalled();
	});

	it("a SUCCESS that OMITS applied.source_preference is treated as unconfirmed (markFieldFailed, not markFieldApplied)", async () => {
		setConfig.mockResolvedValue({ success: true, applied: {} });
		const { container } = render(LiveView);

		await clickReorder(container);

		expect(markFieldApplied).not.toHaveBeenCalled();
		expect(markFieldFailed).toHaveBeenCalledWith("source_preference", [
			"cam-a",
			"cam-b",
		]);
		expect(toastError).toHaveBeenCalled();
	});

	it("a SUCCESSFUL setConfig releases to result.applied.source_preference — the BACKEND order, even when it differs from the sent order", async () => {
		// The backend normalizes the sent ['cam-b','cam-a'] — e.g. appends a
		// newly-seen device. The lock MUST release to THAT applied order, not the
		// optimistic array the client sent.
		const appliedOrder = ["cam-b", "cam-a", "cam-c"];
		setConfig.mockResolvedValue({
			success: true,
			applied: { source_preference: appliedOrder },
		});
		const { container } = render(LiveView);

		await clickReorder(container);

		expect(setConfig).toHaveBeenCalledWith({
			source_preference: ["cam-b", "cam-a"],
		});
		expect(markFieldApplied).toHaveBeenCalledWith(
			"source_preference",
			appliedOrder,
		);
		// Proves the APPLIED order drove the release, not the sent order…
		expect(markFieldApplied).not.toHaveBeenCalledWith("source_preference", [
			"cam-b",
			"cam-a",
		]);
		expect(markFieldFailed).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a THROWN setConfig reverts the lock to the prior order (markFieldFailed)", async () => {
		setConfig.mockRejectedValue(new Error("transport down"));
		const { container } = render(LiveView);

		await clickReorder(container);

		expect(markFieldApplied).not.toHaveBeenCalled();
		expect(markFieldFailed).toHaveBeenCalledWith("source_preference", [
			"cam-a",
			"cam-b",
		]);
		expect(toastError).toHaveBeenCalled();
	});
});
