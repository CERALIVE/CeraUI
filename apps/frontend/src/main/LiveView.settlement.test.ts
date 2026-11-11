// @vitest-environment jsdom
import { m } from "@ceraui/i18n/svelte";
import { act, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	ASYNC_OP_TTL_MS,
	destroyAsyncOperations,
	getOperationPhase,
	getOperationReason,
	initAsyncOperations,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import LiveView from "./LiveView.svelte";

const switchInput = vi.hoisted(() => vi.fn());
const feedback = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { switchInput } },
}));
vi.mock("svelte-sonner", () => ({ toast: feedback }));
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
	getIsStreaming: () => true,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getActiveInput: () => "video0",
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getCapabilities: () => undefined,
	getConfigChange: () => undefined,
	getNetif: () => ({}),
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	getStatus: () => ({}),
	getSources: () => undefined,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/LiveCockpitSwitchStub.svelte"))
		.default,
}));
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(0);
	initAsyncOperations();
});
afterEach(() => {
	destroyAsyncOperations();
	vi.restoreAllMocks();
});

it.each([
	{ success: true, gap_ms: 7, audio_follow_pending: true },
	{ success: false, error: "SOURCE_LOST" },
])(
	"late switch reply %j preserves a retry after timeout (#496)",
	async (reply) => {
		const first = Promise.withResolvers<typeof reply>();
		const second = Promise.withResolvers<{ success: boolean }>();
		switchInput
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const view = render(LiveView);
		await fireEvent.click(screen.getByRole("button", { name: "Switch input" }));
		expect(getOperationPhase("switch-input")).toBe("pending");
		sweepOperations(ASYNC_OP_TTL_MS + 1);
		expect(getOperationPhase("switch-input")).toBe("timed_out");

		// Navigation permits a new dispatch while the old view still awaits its RPC.
		view.unmount();
		render(LiveView);
		await fireEvent.click(screen.getByRole("button", { name: "Switch input" }));
		expect(switchInput).toHaveBeenCalledTimes(2);
		await act(async () => {
			first.resolve(reply);
			await first.promise;
		});
		expect(getOperationPhase("switch-input")).toBe("pending");
		expect(getOperationReason("switch-input")).toBeUndefined();
		if (reply.success) {
			expect(feedback.success).toHaveBeenCalledExactlyOnceWith(
				m["live.inputPicker.switched"]({ ms: 7 }),
			);
			expect(feedback.info).toHaveBeenCalledExactlyOnceWith(
				m["live.inputPicker.audioFollowsOnRestart"](),
			);
			expect(feedback.error).not.toHaveBeenCalled();
		} else {
			expect(feedback.error).toHaveBeenCalledExactlyOnceWith(
				m["live.inputPicker.sourceLost"](),
			);
		}
		await act(async () => {
			second.resolve({ success: true });
			await second.promise;
		});
		expect(getOperationPhase("switch-input")).toBe("confirmed");
	},
);
