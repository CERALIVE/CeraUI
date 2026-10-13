// @vitest-environment jsdom
/**
 * LiveView — the unconfirmed-state Stop is confirmed by DEVICE evidence (the
 * idle commit), never by the band leaving the screen; an unacknowledged Stop
 * keeps UNKNOWN on screen and offers a retry (FIX-16-C3, N3 + g).
 *
 * Mounted with the REAL cockpits (IdleCockpit, LiveCockpit and their
 * StreamControlButton), the REAL unconfirmed-stream band and header, and the
 * REAL optimism and async-operation stores; only the transport (`rpc`), the
 * subscription getters (a reactive lifecycle fixture) and heavy leaves are
 * replaced. The cockpit stubs of the sibling LiveView tests hid what the
 * operator sees. Expectations are literal: control labels and disabled flags,
 * the operation's phase history, the `streaming.stop` call ledger.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { recordOperationPhases } from "../tests/fixtures/operation-phase-log.svelte";
import { streamLifecycleFixture as fx } from "../tests/fixtures/reactive-stream-lifecycle.svelte";
import {
	band,
	button,
	controls,
	deferred,
	FAILED,
	header,
	installJsdomShims,
	OPERATION_KEY as KEY,
	NOT_CONFIRMED,
} from "../tests/fixtures/real-cockpit-harness";

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("svelte-sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));

vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: {
		streaming: { start: vi.fn(), stop: vi.fn(), setConfig: vi.fn() },
		status: { getStatus: vi.fn() },
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) =>
	(await import("../tests/fixtures/real-cockpit-harness")).subscriptionsMock(
		await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>(),
		vi.fn(),
	),
);

vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
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

import {
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import { ConnectionResetError, rpc } from "$lib/rpc/client";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";

import LiveView from "./LiveView.svelte";

const stop = vi.mocked(rpc.streaming.stop);

beforeAll(() => {
	installJsdomShims(vi.fn());
});

beforeEach(() => {
	vi.clearAllMocks();
	fx.reset();
	// main.ts warms both stores before mount; first creating one inside a
	// component's $derived would detach it from the reactive graph.
	initAsyncOperations();
	getStreamingOptimismState();
});

afterEach(() => {
	destroyAsyncOperations();
	destroyStreamingOptimism();
});

describe("Stop confirmation is device evidence, never the band disappearing (N3)", () => {
	it("stop_failed -> Stop -> stopping -> stop_failed reply: failed, feedback shown, Stop enabled again", async () => {
		fx.lifecycle = "stop_failed";
		const { container } = render(LiveView);
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		expect(stop).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledWith();

		// The backend enters `stopping` before it has the engine's answer.
		fx.lifecycle = "stopping";
		flushSync();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Stopping...", disabled: true },
			{ label: "Start Stream", disabled: false },
		]);

		// The engine never answered: the backend commits stop_failed and replies so.
		fx.lifecycle = "stop_failed";
		reply.resolve({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		});
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
		flushSync();
		expect(
			container
				.querySelector('[data-testid="unconfirmed-stream-failed"]')
				?.textContent?.trim(),
		).toBe(FAILED);
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);
		expect(log.phases).toEqual(["idle", "pending", "failed"]);

		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		await fireEvent.click(button(container, "Stop Stream"));
		expect(stop).toHaveBeenCalledTimes(2);
		log.stop();
	});

	it("stop_failed -> Stop -> stopping -> idle -> reply ok: confirmed exactly once, band gone", async () => {
		fx.lifecycle = "stop_failed";
		const { container } = render(LiveView);
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		fx.lifecycle = "stopping";
		flushSync();
		expect(getOperationPhase(KEY)).toBe("pending");

		// The backend publishes its idle commit before it replies `stopped`.
		fx.lifecycle = "idle";
		flushSync();
		expect(getOperationPhase(KEY)).toBe("confirmed");
		reply.resolve({ result: "stopped", success: true });
		await reply.promise;
		flushSync();

		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		sweepOperations(Date.now() + 4_001);
		flushSync();
		expect(log.phases).toEqual(["idle", "pending", "confirmed", "idle"]);
		expect(stop).toHaveBeenCalledTimes(1);
		log.stop();
	});

	it("an absent lifecycle field (older backend, not hydrated) is not confirmation", async () => {
		fx.lifecycle = "stop_failed";
		const { container } = render(LiveView);
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		fx.lifecycle = undefined;
		flushSync();
		expect(getOperationPhase(KEY)).toBe("pending");
		// FIX-16-FRONT3 R2: an absent lifecycle is not settlement, so the
		// operator's unresolved Stop keeps its band (C3 expected it to vanish).
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Stopping...", disabled: true },
			{ label: "Start Stream", disabled: false },
		]);

		fx.lifecycle = "stop_failed";
		reply.resolve({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		});
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
		flushSync();
		expect(band(container)?.textContent).toContain(FAILED);
		expect(log.phases).toEqual(["idle", "pending", "failed"]);
		log.stop();
	});
});

describe("an unacknowledged Stop keeps UNKNOWN on screen and offers a retry (g)", () => {
	it("a reset on the Stop reply: failure feedback, Stop enabled, header never claims Not streaming", async () => {
		fx.lifecycle = "reconciling";
		const { container } = render(LiveView);
		expect(header(container)).not.toContain("Not streaming");
		stop.mockRejectedValueOnce(new ConnectionResetError(["streaming", "stop"]));

		await fireEvent.click(button(container, "Stop Stream"));
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
		flushSync();
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);
		expect(header(container)).not.toContain("Not streaming");
	});

	it("a `stopped` reply while the device stays reconciling is not a confirmed stop", async () => {
		fx.lifecycle = "reconciling";
		const { container } = render(LiveView);
		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);

		await fireEvent.click(button(container, "Stop Stream"));
		await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
		flushSync();
		expect(getOperationPhase(KEY)).toBe("pending");

		sweepOperations(Date.now() + 15_001);
		flushSync();
		expect(getOperationPhase(KEY)).toBe("timed_out");
		expect(band(container)?.textContent).toContain(NOT_CONFIRMED);
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("the header keeps its idle claim when the device has confirmed idle", () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		expect(header(container)).toContain("Not streaming");
	});
});
