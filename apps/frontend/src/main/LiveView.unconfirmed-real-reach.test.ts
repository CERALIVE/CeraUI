// @vitest-environment jsdom
/**
 * LiveView — an unconfirmed backend state always has a reachable, enabled
 * Stop, whatever the local optimism says, and device evidence settles a stale
 * local `starting` (FIX-16-C3, N4).
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

import { streamLifecycleFixture as fx } from "../tests/fixtures/reactive-stream-lifecycle.svelte";
import {
	band,
	button,
	controls,
	deferred,
	installJsdomShims,
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
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { ConnectionResetError, rpc } from "$lib/rpc/client";
import { noteSessionRestored } from "$lib/rpc/session-epoch.svelte";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";

import LiveView from "./LiveView.svelte";

const start = vi.mocked(rpc.streaming.start);
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

/** Press Start in the real idle cockpit and wait for its optimistic edge. */
async function pressStartAndLoseReply(container: HTMLElement): Promise<void> {
	start.mockRejectedValueOnce(new ConnectionResetError(["streaming", "start"]));
	await fireEvent.click(button(container, "Start Stream"));
	await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
	await waitFor(() =>
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]),
	);
}

describe("an unconfirmed backend state always has a reachable Stop (N4)", () => {
	it("lost start reply, reconnect hydrates reconciling: an enabled Stop on screen that sends streaming.stop", async () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		// Reconnect: the session is restored and the hydrate says reconciling.
		fx.lifecycle = "reconciling";
		noteSessionRestored();
		flushSync();

		expect(getStreamingOptimismState()).toBe("idle");
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);
		// Nothing stops on its own (D207).
		expect(stop).toHaveBeenCalledTimes(0);

		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		await fireEvent.click(button(container, "Stop Stream"));
		expect(stop).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledWith();
	});

	it("start in flight, device pushes reconciling: Stop reachable, and the late start refusal does not hide it", async () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		const startReply = deferred<unknown>();
		start.mockReturnValueOnce(startReply.promise as never);
		await fireEvent.click(button(container, "Start Stream"));
		await waitFor(() =>
			expect(controls(container)).toEqual([
				{ label: "Starting...", disabled: true },
			]),
		);

		fx.lifecycle = "starting";
		flushSync();
		fx.lifecycle = "reconciling";
		flushSync();
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);

		startReply.resolve({ success: false, error: "start_in_progress" });
		await startReply.promise;
		flushSync();
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
			{ label: "Start Stream", disabled: false },
		]);
		expect(stop).toHaveBeenCalledTimes(0);
	});

	it("lost start reply, reconnect hydrates idle: the starting optimism settles, no stuck Starting...", async () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);

		// FIX-16-FRONT3 R1: the hydrate DELIVERS the idle lifecycle; a restored
		// session alone (whose hydrate may have failed) is not that evidence
		// (`LiveView.real-store-start.test.ts`).
		noteSessionRestored();
		fx.lifecycle = "idle";
		flushSync();

		expect(getStreamingOptimismState()).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(stop).toHaveBeenCalledTimes(0);
	});

	it("lost start reply, link not yet restored: the pre-reset idle is stale and Starting... stays", async () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);
		flushSync();
		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
	});

	it("lost start reply, the hydrate says the device is still starting: Starting... stays", async () => {
		fx.lifecycle = "idle";
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);
		fx.lifecycle = "starting";
		noteSessionRestored();
		flushSync();
		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
	});

	it("lifecycle absent (older backend): lost reply + restore keeps today's watchdog-bounded Starting...", async () => {
		const { container } = render(LiveView);
		await pressStartAndLoseReply(container);
		noteSessionRestored();
		flushSync();
		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
	});

	it("is_streaming true: the live cockpit's own Stop, never doubled by the band", () => {
		fx.streaming = true;
		fx.lifecycle = "streaming";
		const { container } = render(LiveView);
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
		]);

		fx.lifecycle = "reconciling";
		flushSync();
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
		]);
	});
});
