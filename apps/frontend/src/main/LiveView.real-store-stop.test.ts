// @vitest-environment jsdom
/**
 * An operator Stop whose outcome is UNKNOWN keeps its recovery surface until
 * the device settles it (FIX-16-FRONT3 R2), and a full status snapshot
 * REPLACES the lifecycle while a partial push MERGES it (R4).
 *
 * Everything on the status path is real: the subscription store's handlers,
 * its reconnect re-authentication and hydrate, `ingestPulledStatus`, the
 * session epoch, the optimism and async-operation stores, LiveView with its
 * real cockpits, band and header. Only the transport, the static device
 * getters (config, sources, network) and heavy leaves are scripted.
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
import {
	band,
	button,
	controls,
	deferred,
	FAILED,
	header,
	installJsdomShims,
	OPERATION_KEY as KEY,
} from "../tests/fixtures/real-cockpit-harness";
import {
	dropLink,
	firstLink,
	push,
	restoreLink,
	type ScriptedTransport,
} from "../tests/fixtures/real-store-live";

const transport = vi.hoisted(
	(): ScriptedTransport => ({
		message: undefined,
		connection: undefined,
		authenticated: false,
	}),
);

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
		auth: { login: vi.fn(async () => ({ success: true })) },
		streaming: {
			start: vi.fn(),
			stop: vi.fn(),
			setConfig: vi.fn(),
			getConfig: vi.fn(async () => ({})),
		},
		status: { getStatus: vi.fn() },
	},
	rpcClient: (await import("../tests/fixtures/real-store-live")).rpcClientMock(
		transport,
	),
}));
vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) =>
	(await import("../tests/fixtures/real-store-live")).deviceGettersMock(
		await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>(),
	),
);
vi.mock("$lib/stores/connection-ux.svelte", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/stores/connection-ux.svelte")
	>()),
	wasAuthenticated: () => transport.authenticated,
}));
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("$lib/components/preview/PreviewCanvas.svelte", noop);
vi.mock("$lib/components/custom/ComingSoon.svelte", noop);
vi.mock("$main/live/CapabilityTierBanner.svelte", noop);
vi.mock("$main/dialogs/ServerDialog.svelte", noop);
vi.mock("$main/dialogs/AudioDialog.svelte", noop);
vi.mock("$main/dialogs/EncoderDialog.svelte", noop);

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
import {
	getStatus,
	ingestPulledStatus,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { operatorStopUnresolved } from "$lib/streaming/unresolved-stream-actions.svelte";

import LiveView from "./LiveView.svelte";

const stop = vi.mocked(rpc.streaming.stop);
const getStatusRpc = vi.mocked(rpc.status.getStatus);

beforeAll(() => {
	installJsdomShims(vi.fn());
});

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.setItem("auth", "token-abc");
	resetState();
	initSubscriptions();
	initAsyncOperations();
	getStreamingOptimismState();
	firstLink(transport);
	push(transport, { is_streaming: false, stream_lifecycle: "idle" });
});

afterEach(() => {
	destroyAsyncOperations();
	destroyStreamingOptimism();
	dropLink(transport);
	localStorage.clear();
	document.body.innerHTML = "";
});

const STOP_AND_START = [
	{ label: "Stop Stream", disabled: false },
	{ label: "Start Stream", disabled: false },
];

/**
 * stop_failed -> the operator presses Stop -> the device publishes `stopping`
 * -> the socket resets before any terminal reply or push.
 */
async function loseTheStopReplyAfterStopping(
	container: HTMLElement,
): Promise<void> {
	push(transport, { is_streaming: false, stream_lifecycle: "stop_failed" });
	expect(controls(container)).toEqual(STOP_AND_START);
	let lose!: (error: unknown) => void;
	stop.mockReturnValueOnce(
		new Promise((_resolve, reject) => {
			lose = reject;
		}) as never,
	);
	await fireEvent.click(button(container, "Stop Stream"));
	expect(stop).toHaveBeenCalledTimes(1);
	push(transport, { stream_lifecycle: "stopping" });
	expect(controls(container)).toEqual([
		{ label: "Stopping...", disabled: true },
		{ label: "Start Stream", disabled: false },
	]);
	lose(new ConnectionResetError(["streaming", "stop"]));
	dropLink(transport);
	await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
	flushSync();
}

describe("R2: a lost Stop reply keeps the unresolved Stop reachable", () => {
	it("a lost stop reply keeps the unconfirmed stop reachable", async () => {
		const { container } = render(LiveView);
		await loseTheStopReplyAfterStopping(container);

		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(band(container)).not.toBeNull();
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");

		// Re-authentication succeeds but the hydrate fails: still no settlement.
		await restoreLink(transport, getStatusRpc, { fails: true });
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		// Nothing stopped on its own (D207).
		expect(stop).toHaveBeenCalledTimes(1);

		// The device's idle commit, delivered on the current link, settles it.
		push(transport, { stream_lifecycle: "idle" });
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("the unresolved Stop survives the Live view being mounted anew", async () => {
		const first = render(LiveView);
		await loseTheStopReplyAfterStopping(first.container);
		first.unmount();

		const { container } = render(LiveView);
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
	});

	it("an acknowledged stop ends the claim even when no lifecycle follows", async () => {
		const { container } = render(LiveView);
		await loseTheStopReplyAfterStopping(container);
		await restoreLink(transport, getStatusRpc, { fails: true });

		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		await fireEvent.click(button(container, "Stop Stream"));
		await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
		flushSync();
		// The reply alone does not confirm the operation (C3) ...
		expect(getOperationPhase(KEY)).toBe("pending");
		sweepOperations(Date.now() + 15_001);
		flushSync();
		// ... but the device acknowledged the Stop, so the claim is over.
		expect(getOperationPhase(KEY)).toBe("timed_out");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});
});

const STOPPING_AND_START = [
	{ label: "Stopping...", disabled: true },
	{ label: "Start Stream", disabled: false },
];

/**
 * PRE4-C C4-1: the Stop reply is lost after `stopping`, the operator navigates
 * away, the reconnect hydrate delivers idle while LiveView is unmounted, the
 * link drops again and the next hydrate FAILS, retaining that idle. Back on
 * Live, the claim is unresolved and the held idle belongs to an older link.
 */
async function returnOverRetainedIdle(): Promise<HTMLElement> {
	const first = render(LiveView);
	await loseTheStopReplyAfterStopping(first.container);
	first.unmount();
	await restoreLink(transport, getStatusRpc, {
		status: { is_streaming: false, stream_lifecycle: "idle" },
	});
	dropLink(transport);
	await restoreLink(transport, getStatusRpc, { fails: true });
	expect(getStatus()?.stream_lifecycle).toBe("idle");

	const { container } = render(LiveView);
	expect(band(container)).not.toBeNull();
	expect(controls(container)).toEqual(STOP_AND_START);
	expect(header(container)).not.toContain("Not streaming");
	return container;
}

describe("F4 C4-1: a retry is confirmed only by idle delivered after it over the current link", () => {
	it("a retained idle cannot confirm the retry or swallow its stop_failed", async () => {
		const container = await returnOverRetainedIdle();
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		flushSync();
		expect(stop).toHaveBeenCalledTimes(2);
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(STOPPING_AND_START);
		expect(header(container)).not.toContain("Not streaming");

		reply.resolve({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		});
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
		flushSync();
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		expect(log.phases).not.toContain("confirmed");
		expect(log.phases.slice(-2)).toEqual(["pending", "failed"]);
		expect(stop).toHaveBeenCalledTimes(2);
		log.stop();
	});

	it("the retry is confirmed by an idle delivered after it on the current link", async () => {
		const container = await returnOverRetainedIdle();
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		flushSync();
		expect(getOperationPhase(KEY)).toBe("pending");

		push(transport, { is_streaming: false, stream_lifecycle: "idle" });
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);

		reply.resolve({ result: "stopped", success: true });
		await reply.promise;
		flushSync();
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(log.phases.slice(-2)).toEqual(["pending", "confirmed"]);
		expect(stop).toHaveBeenCalledTimes(2);
		log.stop();
	});

	it("stop_failed -> Stop -> stopping -> ok -> idle: confirmed exactly once", async () => {
		const { container } = render(LiveView);
		push(transport, { is_streaming: false, stream_lifecycle: "stop_failed" });
		const log = recordOperationPhases(KEY);
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		push(transport, { stream_lifecycle: "stopping" });
		expect(operatorStopUnresolved()).toBe(true);
		reply.resolve({ result: "stopped", success: true });
		// The acknowledgement must have closed the claim BEFORE the idle arrives,
		// or this cell only replays the idle-then-reply order.
		await waitFor(() => expect(operatorStopUnresolved()).toBe(false));
		flushSync();
		// The acknowledgement ends the claim; only the idle commit confirms.
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual(STOPPING_AND_START);

		push(transport, { stream_lifecycle: "idle" });
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		sweepOperations(Date.now() + 4_001);
		flushSync();
		expect(log.phases).toEqual(["idle", "pending", "confirmed", "idle"]);
		expect(stop).toHaveBeenCalledTimes(1);
		log.stop();
	});

	it("is_streaming true after the press hides the band but confirms nothing", async () => {
		const { container } = render(LiveView);
		push(transport, { is_streaming: false, stream_lifecycle: "stop_failed" });
		stop.mockReturnValueOnce(new Promise(() => {}) as never);

		await fireEvent.click(button(container, "Stop Stream"));
		push(transport, { is_streaming: true, stream_lifecycle: "streaming" });
		expect(band(container)).toBeNull();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("a full snapshot without a lifecycle after the press does not confirm it", async () => {
		const { container } = render(LiveView);
		push(transport, { is_streaming: false, stream_lifecycle: "stop_failed" });
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);

		await fireEvent.click(button(container, "Stop Stream"));
		ingestPulledStatus({ is_streaming: false });
		flushSync();
		expect(getStatus()?.stream_lifecycle).toBeUndefined();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual(STOPPING_AND_START);

		reply.resolve({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		});
		await waitFor(() => expect(getOperationPhase(KEY)).toBe("failed"));
		flushSync();
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
	});
});

describe("R4: a full snapshot replaces the lifecycle, a partial push merges it", () => {
	it("a full snapshot without a lifecycle clears the old lifecycle but a partial push does not", () => {
		const { container } = render(LiveView);
		push(transport, { is_streaming: false, stream_lifecycle: "reconciling" });
		expect(band(container)).not.toBeNull();

		// A partial push that omits the field keeps it.
		push(transport, { is_streaming: false });
		expect(getStatus()?.stream_lifecycle).toBe("reconciling");
		expect(band(container)).not.toBeNull();

		// An authoritative pulled snapshot from an older backend has no lifecycle.
		ingestPulledStatus({ is_streaming: false });
		flushSync();
		expect(getStatus()?.stream_lifecycle).toBeUndefined();
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
	});

	it("the reconnect hydrate is a full snapshot too", async () => {
		const { container } = render(LiveView);
		push(transport, { is_streaming: false, stream_lifecycle: "reconciling" });
		expect(band(container)).not.toBeNull();

		dropLink(transport);
		await restoreLink(transport, getStatusRpc, {
			status: { is_streaming: false },
		});
		expect(getStatus()?.stream_lifecycle).toBeUndefined();
		expect(band(container)).toBeNull();
	});
});
