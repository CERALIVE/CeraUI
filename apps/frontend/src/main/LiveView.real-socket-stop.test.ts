// @vitest-environment jsdom
/**
 * A reply to an earlier Stop never settles a later Stop's claim (FIX-16-F4,
 * PRE4-C C4-2), proven over the ACTUAL transport: the real `rpc` proxy and
 * `RPCClient` on a scripted WebSocket, the real subscription store with its
 * reconnect re-authentication and hydrate, the session epoch, the optimism and
 * async-operation stores, and LiveView with its real cockpits, band and header.
 * Every reply is delivered by its own request id; every timer is Vitest's fake
 * clock. Only the static device getters and heavy leaves are scripted.
 *
 * Two setup traps of the review's harness are avoided on purpose: only
 * `initSubscriptions()` opens the socket (a second `connect()` while one is
 * open is a connection-ownership violation), and the async-operation sweep is
 * created AFTER the fake clock, or its 15 s valve would run on real time.
 */
import { fireEvent, render } from "@testing-library/svelte";
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
	FAILED,
	header,
	installJsdomShims,
	OPERATION_KEY as KEY,
	NOT_CONFIRMED,
} from "../tests/fixtures/real-cockpit-harness";
import {
	answer,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	outstanding,
	reject,
	restoreLink,
	type SentRequest,
	sentCount,
	socket,
} from "../tests/helpers/update-device";

const session = vi.hoisted(() => ({ authenticated: false }));

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
vi.mock("$lib/rpc/subscriptions.svelte", async (importOriginal) =>
	(await import("../tests/fixtures/real-store-live")).deviceGettersMock(
		await importOriginal<typeof import("$lib/rpc/subscriptions.svelte")>(),
	),
);
vi.mock("$lib/stores/connection-ux.svelte", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/stores/connection-ux.svelte")
	>()),
	wasAuthenticated: () => session.authenticated,
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
} from "$lib/rpc/async-operation.svelte";
import { rpcClient } from "$lib/rpc/client";
import { getRestoredSessions } from "$lib/rpc/session-epoch.svelte";
import {
	destroyStreamingOptimism,
	getStreamingOptimismState,
} from "$lib/rpc/streaming-optimism.svelte";
import {
	getStatus,
	ingestPulledStatus,
	initSubscriptions,
	receivePulledStatus,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

import LiveView from "./LiveView.svelte";

const STOP_AND_START = [
	{ label: "Stop Stream", disabled: false },
	{ label: "Start Stream", disabled: false },
];
const STOPPING_AND_START = [
	{ label: "Stopping...", disabled: true },
	{ label: "Start Stream", disabled: false },
];

// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];
const realWebSocket = globalThis.WebSocket;
let jitter: { mockRestore(): void } | undefined;

/** The device pushes a status frame over the open socket. */
function deliverStatus(frame: Record<string, unknown>): void {
	socket().deliver({ status: frame });
	flushSync();
}

async function settle(): Promise<void> {
	await flush();
	flushSync();
}

beforeAll(() => {
	installJsdomShims(vi.fn());
});

beforeEach(() => {
	vi.useFakeTimers();
	// The reconnect backoff's jitter is the only randomness on this path.
	jitter = vi.spyOn(Math, "random").mockReturnValue(0.5);
	FakeWebSocket.current = undefined;
	FakeWebSocket.log.length = 0;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://device.test/ws";
	localStorage.setItem("auth", "token-abc");
	resetState();
	initAsyncOperations();
	getStreamingOptimismState();
	flushSync();
	session.authenticated = false;
	initSubscriptions();
	// Later tests of this file: the store is already initialised and its one
	// client was disconnected by the previous teardown, so it reopens here.
	if (FakeWebSocket.current === undefined) rpcClient.connect();
	socket().readyState = FakeWebSocket.OPEN;
	socket().onopen?.();
	session.authenticated = true;
	flushSync();
	deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
});

afterEach(() => {
	rpcClient.disconnect();
	destroyAsyncOperations();
	destroyStreamingOptimism();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	jitter?.mockRestore();
	vi.useRealTimers();
	localStorage.clear();
	document.body.innerHTML = "";
});

/**
 * stop_failed -> the operator's Stop -> `stopping` -> the first request is
 * still awaited when the shared 15 s valve lapses -> the operator retries.
 * Returns both requests, oldest first, both still awaited.
 */
async function retryWhileTheFirstStopIsAwaited(
	container: HTMLElement,
): Promise<readonly [SentRequest, SentRequest]> {
	deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
	expect(controls(container)).toEqual(STOP_AND_START);

	await fireEvent.click(button(container, "Stop Stream"));
	await settle();
	deliverStatus({ stream_lifecycle: "stopping" });
	expect(controls(container)).toEqual(STOPPING_AND_START);

	await elapse(16_000);
	flushSync();
	expect(getOperationPhase(KEY)).toBe("timed_out");
	expect(band(container)?.textContent).toContain(NOT_CONFIRMED);
	expect(controls(container)).toEqual(STOP_AND_START);

	await fireEvent.click(button(container, "Stop Stream"));
	await settle();
	const [first, retry] = outstanding("streaming.stop");
	expect(sentCount("streaming.stop")).toBe(2);
	if (first === undefined || retry === undefined)
		throw new Error("both Stop requests must still be awaited");
	expect(first.id).not.toBe(retry.id);
	expect(getOperationPhase(KEY)).toBe("pending");
	return [first, retry];
}

describe("F4 C4-2: every Stop reply settles only its own claim", () => {
	it("an older acknowledgement cannot erase the newer Stop before it is lost", async () => {
		const { container } = render(LiveView);
		const [, retry] = await retryWhileTheFirstStopIsAwaited(container);

		// The FIRST request's delayed acknowledgement, by its own request id.
		answer("streaming.stop", { result: "stopped", success: true }, "oldest");
		await settle();
		expect(outstanding("streaming.stop").map((r) => r.id)).toEqual([retry.id]);
		expect(getOperationPhase(KEY)).toBe("pending");

		// The socket resets while the retry is unresolved.
		dropLink();
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(2);

		// Only the device's idle commit on the NEW link settles it.
		await restoreLink();
		answer("auth.login", { success: true });
		await settle();
		answer("streaming.getConfig", {});
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.stop")).toBe(2);
	});

	it("an older acknowledgement after the newer Stop failed does not settle it", async () => {
		const { container } = render(LiveView);
		await retryWhileTheFirstStopIsAwaited(container);

		answer(
			"streaming.stop",
			{ result: "stop_failed", reason: "stop_timeout", success: false },
			"newest",
		);
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);

		answer("streaming.stop", { result: "stopped", success: true }, "oldest");
		await settle();
		expect(outstanding("streaming.stop")).toEqual([]);
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(2);
	});

	it("the newer Stop's own acknowledgement still ends its claim", async () => {
		const { container } = render(LiveView);
		await retryWhileTheFirstStopIsAwaited(container);

		answer("streaming.stop", { result: "stopped", success: true }, "oldest");
		answer("streaming.stop", { result: "stopped", success: true }, "newest");
		await settle();
		// Acknowledged, not yet confirmed: the pending Stop keeps its spinner
		// while the device still says `stopping`.
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual(STOPPING_AND_START);

		// No lifecycle follows: the valve lapses and the acknowledged claim is
		// over, so nothing keeps the band (FIX-16-FRONT3, D207).
		await elapse(16_000);
		flushSync();
		expect(getOperationPhase(KEY)).toBe("timed_out");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.stop")).toBe(2);
	});
});

/**
 * The link drops and comes back; re-authentication succeeds and both safety
 * hydrate requests are still awaited.
 */
async function reconnectAwaitingHydrate(): Promise<void> {
	dropLink();
	await settle();
	await restoreLink();
	answer("auth.login", { success: true });
	await settle();
	expect(outstanding("streaming.getConfig")).toHaveLength(1);
	expect(outstanding("status.getStatus")).toHaveLength(1);
}

const STOP_FAILED_REPLY = {
	result: "stop_failed",
	reason: "stop_timeout",
	success: false,
};
const START_ONLY = [{ label: "Start Stream", disabled: false }];

describe("F5 F4-R1: a status answer is evidence at its own receipt", () => {
	it("a hydrate status received before the claim cannot settle it after a delayed config", async () => {
		const { container } = render(LiveView);
		await reconnectAwaitingHydrate();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		expect(controls(container)).toEqual(STOP_AND_START);

		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus({ stream_lifecycle: "stopping" });
		answer("streaming.getConfig", {});
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(STOPPING_AND_START);
		expect(outstanding("streaming.stop")).toHaveLength(1);

		answer("streaming.stop", STOP_FAILED_REPLY);
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("the status answer applies at its own receipt and never over a newer push", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		await reconnectAwaitingHydrate();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		// Applied while the config reply is still awaited.
		expect(outstanding("streaming.getConfig")).toHaveLength(1);
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");

		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		answer("streaming.getConfig", {});
		await settle();
		expect(getStatus()?.stream_lifecycle).toBe("stop_failed");
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(header(container)).not.toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("a config answered first holds nothing back, and a status answered after the claim confirms it once", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		const restored = getRestoredSessions();
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		await settle();
		expect(outstanding("status.getStatus")).toHaveLength(1);
		expect(getStatus()?.stream_lifecycle).toBe("stop_failed");

		const log = recordOperationPhases(KEY);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus({ stream_lifecycle: "stopping" });
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(getRestoredSessions()).toBe(restored + 1);
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(band(container)).toBeNull();
		expect(header(container)).toContain("Not streaming");
		expect(controls(container)).toEqual(START_ONLY);

		answer("streaming.stop", { result: "stopped", success: true });
		await settle();
		expect(log.phases).toEqual(["idle", "pending", "confirmed"]);
		log.stop();
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("after a pre-claim answer, an idle pushed after the claim still confirms exactly once", async () => {
		const { container } = render(LiveView);
		await reconnectAwaitingHydrate();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		const log = recordOperationPhases(KEY);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus({ stream_lifecycle: "stopping" });
		answer("streaming.getConfig", {});
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");

		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		expect(getOperationPhase(KEY)).toBe("confirmed");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual(START_ONLY);
		answer("streaming.stop", { result: "stopped", success: true });
		await settle();
		expect(log.phases).toEqual(["idle", "pending", "confirmed"]);
		log.stop();
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("a failed status answer settles nothing while the config and the restoration still land", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		const restored = getRestoredSessions();
		await reconnectAwaitingHydrate();
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		reject("status.getStatus", "INTERNAL_ERROR");
		answer("streaming.getConfig", {});
		await settle();
		expect(getRestoredSessions()).toBe(restored + 1);
		expect(getStatus()?.stream_lifecycle).toBe("stop_failed");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(band(container)).not.toBeNull();

		answer("streaming.stop", STOP_FAILED_REPLY);
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(STOP_AND_START);
		expect(sentCount("streaming.stop")).toBe(1);
	});
});

/**
 * The carrier contract on its own: a consumer that HOLDS a pulled answer and
 * ingests it later (the F4-R1 shape, independent of the reconnect hydrate).
 */
describe("F5 F4-R1: a pulled answer keeps the moment it was received", () => {
	it("an answer consumed late cannot overwrite a newer push nor settle a later claim", async () => {
		const { container } = render(LiveView);
		const late = receivePulledStatus({
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus({ stream_lifecycle: "stopping" });

		ingestPulledStatus(late.status, late.receipt);
		await settle();
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual(STOPPING_AND_START);
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("an answer received before the claim is not evidence after it, however late it is consumed", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		const late = receivePulledStatus({
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();

		ingestPulledStatus(late.status, late.receipt);
		await settle();
		// The newest device answer is held, but it predates the press.
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(band(container)).not.toBeNull();

		answer("streaming.stop", STOP_FAILED_REPLY);
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(sentCount("streaming.stop")).toBe(1);
	});
});

/** The stop watchdog's pull is consumed in receipt order with the pushes. */
describe("F5 sweep: the stop watchdog's pull keeps receipt order", () => {
	async function stopUntilTheWatchdogPulls(
		container: HTMLElement,
	): Promise<void> {
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		expect(sentCount("streaming.stop")).toBe(1);
		await elapse(15_000);
		flushSync();
		expect(outstanding("status.getStatus")).toHaveLength(1);
	}

	it("a pull answered after a newer push is the newer answer", async () => {
		const { container } = render(LiveView);
		await stopUntilTheWatchdogPulls(container);
		deliverStatus({ is_streaming: true, stream_lifecycle: "stopping" });
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(header(container)).toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("a push after the pull's answer wins over it", async () => {
		const { container } = render(LiveView);
		await stopUntilTheWatchdogPulls(container);
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		await settle();
		expect(getStatus()?.stream_lifecycle).toBe("stop_failed");
		expect(band(container)).not.toBeNull();
		expect(header(container)).not.toContain("Not streaming");
		expect(sentCount("streaming.stop")).toBe(1);
	});
});
