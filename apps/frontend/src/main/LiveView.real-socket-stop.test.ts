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
	CAPABLE,
	deviceDetails,
	dropLink,
	elapse,
	FakeWebSocket,
	flush,
	outstanding,
	reject,
	restoreLink,
	SETTINGS,
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
vi.mock("$lib/helpers/NavigationHelper", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/helpers/NavigationHelper")>()),
	setupHashNavigation: () => () => undefined,
}));
vi.mock("$lib/i18n/namespace-activation", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/i18n/namespace-activation")>()),
	areDestinationNamespacesLoaded: () => true,
	ensureDestinationNamespaces: async () => undefined,
}));
vi.mock("$lib/stores/navigation.svelte", async (importOriginal) => {
	const feed = await import("./navigation/__fixtures__/navigation-feed.svelte");
	const readable = <T>(value: T) => ({
		subscribe: (run: (value: T) => void) => {
			run(value);
			return () => undefined;
		},
	});
	return {
		...(await importOriginal<typeof import("$lib/stores/navigation.svelte")>()),
		getCurrentNavigation: feed.getCurrentNavigationFeed,
		isNavigationTransitioning: readable(false),
		navigationError: readable(null),
		transitionDirection: readable("forward" as const),
	};
});
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
} from "../lib/rpc/async-operation.svelte";
import { rpcClient } from "../lib/rpc/client";
import { pullStatusEvidence } from "../lib/rpc/pulled-status";
import { getRestoredSessions } from "../lib/rpc/session-epoch.svelte";
import {
	destroyStreamingOptimism,
	getStreamingAttemptGeneration,
	getStreamingOptimismState,
} from "../lib/rpc/streaming-optimism.svelte";
import {
	getStatus,
	ingestPulledStatus,
	initSubscriptions,
	receivePulledStatus,
	resetState,
} from "../lib/rpc/subscriptions.svelte";
import {
	clearStartRecoveryUnknown,
	noteLostStartReply,
	noteStartRecoveryUnknown,
	startRecoveryUnknown,
} from "../lib/streaming/unresolved-stream-actions.svelte";
import Noop from "../tests/fixtures/Noop.svelte";
import UpdatesDialog from "./dialogs/UpdatesDialog.svelte";
import LiveView from "./LiveView.svelte";
import {
	publishNavigation,
	resetNavigationFeed,
} from "./navigation/__fixtures__/navigation-feed.svelte";
import NavigationRenderer from "./navigation/NavigationRenderer.svelte";

const STOP_AND_START = [
	{ label: "Stop Stream", disabled: false },
	{ label: "Start Stream", disabled: false },
];

const F7_WIFI = {
	"0": { ifname: "wlan0", conn: "test-net", hw: "radio", saved: {} },
};
const F7_MODEMS = {
	"0": {
		ifname: "wwan0",
		name: "Test modem",
		network_type: { supported: ["4G"], active: "4G" },
	},
};
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
	resetNavigationFeed();
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

const F8_MIXED_FALSE = {
	is_streaming: false,
	active_encode: null,
	engine_bitrate: null,
	preview_encoder_realized: null,
} as const;
const F8_RECOVERY_CONTROLS = [
	{ label: "Stop Stream", disabled: false },
	{ label: "Starting...", disabled: true },
] as const;

/** A real acknowledged Start with two superseded watchdog answers, never a stubbed reader. */
async function exhaustStart(
	container: HTMLElement,
	push: Record<string, unknown> = F8_MIXED_FALSE,
	streaming = false,
): Promise<void> {
	await fireEvent.click(button(container, "Start Stream"));
	await settle();
	answer("streaming.start", { success: true });
	await settle();
	await elapse(90_000);
	for (let read = 0; read < 2; read += 1) {
		expect(outstanding("status.getStatus")).toHaveLength(1);
		await elapse(1_100);
		deliverStatus(push);
		await settle();
		answer("status.getStatus", {
			is_streaming: streaming,
			stream_lifecycle: streaming ? "streaming" : "idle",
			ssh: true,
		});
		await settle();
	}
}

describe("F9 Stop acknowledgement owns the captured Start lifetime", () => {
	it("a same-attempt Stop ack before read exhaustion must not create recovery UNKNOWN", async () => {
		// Given the reviewer's first exhausted Start and an independent failed Stop claim.
		const { container } = render(LiveView);
		await exhaustStart(container, { stream_lifecycle: "starting" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus(F8_MIXED_FALSE);
		await settle();
		expect(getStreamingOptimismState()).toBe("idle");
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		reject("streaming.stop", "INTERNAL_ERROR");
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(controls(container)).toEqual(STOP_AND_START);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await settle();
		const generation = getStreamingAttemptGeneration();
		await elapse(90_000);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		// When this generation's latest Stop acknowledges before the first recovery answer.
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		answer("streaming.stop", { success: true, result: "stopped" });
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		await elapse(1_100);
		deliverStatus(F8_MIXED_FALSE);
		await settle();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		if (outstanding("status.getStatus").length > 0) {
			await elapse(1_100);
			deliverStatus(F8_MIXED_FALSE);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
		}
		await elapse(180_000);
		// Then the revoked cycle requests no replacement and cannot manufacture UNKNOWN.
		expect(startRecoveryUnknown(generation)).toBe(false);
		expect(getStreamingOptimismState()).toBe("idle");
		expect(getStatus()?.stream_lifecycle).toBe("starting");
		expect(getOperationPhase(KEY)).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(FakeWebSocket.log.map((r) => r.path)).toEqual([
			"streaming.start",
			"status.getStatus",
			"status.getStatus",
			"streaming.stop",
			"streaming.start",
			"status.getStatus",
			"streaming.stop",
		]);
	});

	it.each(["before", "after"] as const)(
		"simple Stop acknowledgement %s exhaustion settles its attempt",
		async (ack) => {
			// Given a reachable band from an ordinary failed Stop, not a fabricated recovery record.
			const { container } = render(LiveView);
			deliverStatus({ stream_lifecycle: "stop_failed" });
			await settle();
			await fireEvent.click(button(container, "Stop Stream"));
			await settle();
			reject("streaming.stop", "INTERNAL_ERROR");
			await settle();
			deliverStatus({ stream_lifecycle: "starting" });
			await settle();
			await fireEvent.click(button(container, "Start Stream"));
			await settle();
			answer("streaming.start", { success: true });
			await settle();
			const generation = getStreamingAttemptGeneration();
			await elapse(90_000);
			await elapse(1_100);
			deliverStatus(F8_MIXED_FALSE);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
			expect(outstanding("status.getStatus")).toHaveLength(1);
			// When Stop acknowledges on either side of the second read's exhaustion.
			await fireEvent.click(button(container, "Stop Stream"));
			await settle();
			if (ack === "before") {
				answer("streaming.stop", { success: true, result: "stopped" });
				await settle();
			}
			await elapse(1_100);
			deliverStatus(F8_MIXED_FALSE);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
			if (ack === "after") {
				expect(startRecoveryUnknown(generation)).toBe(true);
				expect(band(container)?.textContent).toContain(
					"Stream state not confirmed",
				);
				answer("streaming.stop", { success: true, result: "stopped" });
				await settle();
			}
			// Then Stop settles the attempt, not the operation or held backend lifecycle.
			expect(getOperationPhase(KEY)).toBe("pending");
			expect(getStreamingOptimismState()).toBe("idle");
			expect(getStatus()?.stream_lifecycle).toBe("starting");
			expect(startRecoveryUnknown(generation)).toBe(false);
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual([
				{ label: "Start Stream", disabled: false },
			]);
			await elapse(180_000);
			expect(getOperationPhase(KEY)).toBe("idle");
			expect(startRecoveryUnknown(generation)).toBe(false);
			expect(sentCount("status.getStatus")).toBe(2);
			expect(sentCount("streaming.stop")).toBe(2);
		},
	);

	for (const exhaustion of ["before", "after"] as const) {
		for (const outcome of ["ack", "error"] as const) {
			for (const nextStart of [false, true]) {
				it(`matrix exhaustion=${exhaustion} Stop=${outcome} nextStart=${nextStart}`, async () => {
					// Given Start #1 exhaustion, failed Stop #1 and a naturally reachable Start #2 band.
					const { container } = render(LiveView);
					await exhaustStart(container, { stream_lifecycle: "starting" });
					await fireEvent.click(button(container, "Stop Stream"));
					await settle();
					deliverStatus(F8_MIXED_FALSE);
					await settle();
					reject("streaming.stop", "INTERNAL_ERROR");
					await settle();
					await fireEvent.click(button(container, "Start Stream"));
					await settle();
					answer("streaming.start", { success: true });
					await settle();
					const generation = getStreamingAttemptGeneration();
					await elapse(90_000);
					await fireEvent.click(button(container, "Stop Stream"));
					await settle();
					const reply = async () => {
						if (outcome === "ack")
							answer("streaming.stop", { success: true, result: "stopped" });
						else reject("streaming.stop", "INTERNAL_ERROR");
						await settle();
					};
					// When the Stop result is before/after the current watchdog's exhausted budget.
					if (exhaustion === "after") await reply();
					const reads = exhaustion === "after" && outcome === "ack" ? 1 : 2;
					for (let read = 0; read < reads; read += 1) {
						await elapse(1_100);
						deliverStatus(F8_MIXED_FALSE);
						await settle();
						answer("status.getStatus", {
							is_streaming: false,
							stream_lifecycle: "idle",
						});
						await settle();
					}
					if (exhaustion === "before") await reply();
					// Then failure preserves UNKNOWN; acknowledgement revokes the captured cycle.
					expect(getOperationPhase(KEY)).toBe(
						outcome === "ack" ? "pending" : "failed",
					);
					expect(startRecoveryUnknown(generation)).toBe(outcome === "error");
					expect(getStreamingOptimismState()).toBe(
						outcome === "ack" ? "idle" : "starting",
					);
					expect(getStatus()?.stream_lifecycle).toBe("starting");
					expect(controls(container)).toEqual(
						outcome === "ack"
							? [{ label: "Start Stream", disabled: false }]
							: F8_RECOVERY_CONTROLS,
					);
					if (outcome === "error")
						expect(band(container)?.textContent).toContain(
							"Stream state not confirmed",
						);
					else expect(band(container)).toBeNull();
					if (nextStart) {
						// Failed Stop needs independent affirmative evidence before retry is possible.
						if (outcome === "error") {
							deliverStatus(F8_MIXED_FALSE);
							await settle();
						}
						await fireEvent.click(button(container, "Start Stream"));
						await settle();
						answer("streaming.start", { success: true });
						await settle();
						expect(getStreamingAttemptGeneration()).toBe(generation + 1);
						expect(startRecoveryUnknown(generation + 1)).toBe(false);
						expect(getStreamingOptimismState()).toBe("starting");
					}
					expect(sentCount("status.getStatus")).toBe(2 + reads);
					expect(sentCount("streaming.stop")).toBe(2);
					expect(sentCount("streaming.start")).toBe(nextStart ? 3 : 2);
				});
			}
		}
	}

	it("an old Stop owner's acknowledgement before exhaustion cannot revoke the retry's Start", async () => {
		// Given an unresolved claim keeps Stop reachable for a new Start watchdog.
		const { container } = render(LiveView);
		await exhaustStart(container, { stream_lifecycle: "starting" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus(F8_MIXED_FALSE);
		await settle();
		reject("streaming.stop", "INTERNAL_ERROR");
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await settle();
		await elapse(90_000);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(16_100);
		expect(getOperationPhase(KEY)).toBe("timed_out");
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		// When the earlier request still within its real 30 s client budget acknowledges.
		answer("streaming.stop", { success: true, result: "stopped" }, "oldest");
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getStreamingOptimismState()).toBe("starting");
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		expect(controls(container)).toEqual([
			{ label: "Stopping...", disabled: true },
			{ label: "Starting...", disabled: true },
		]);
		for (let read = 0; read < 2; read += 1) {
			await elapse(1_100);
			deliverStatus(F8_MIXED_FALSE);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
		}
		// Then only the latest explicit owner's acknowledgement settles the captured attempt.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(band(container)?.textContent).toContain(
			"Stream state not confirmed",
		);
		answer("streaming.stop", { success: true, result: "stopped" }, "newest");
		await settle();
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		expect(getStreamingOptimismState()).toBe("idle");
		expect(getStatus()?.stream_lifecycle).toBe("starting");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("status.getStatus")).toBe(4);
		expect(sentCount("streaming.stop")).toBe(3);
	});

	it("an old Stop generation acknowledgement cannot revoke a newer Start or its later record", async () => {
		// Given an old Stop still awaiting its real request-id-selected reply.
		const { container } = render(LiveView);
		await exhaustStart(container, { stream_lifecycle: "starting" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus(F8_MIXED_FALSE);
		await settle();
		const oldGeneration = getStreamingAttemptGeneration();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await settle();
		const generation = getStreamingAttemptGeneration();
		expect(generation).toBe(oldGeneration + 1);
		// When the latest Stop owner's reply arrives, but its captured Start generation is old.
		answer("streaming.stop", { success: true, result: "stopped" });
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getStreamingOptimismState()).toBe("starting");
		expect(getStatus()?.stream_lifecycle).toBe("starting");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
		await elapse(90_000);
		for (let read = 0; read < 2; read += 1) {
			await elapse(1_100);
			deliverStatus(F8_MIXED_FALSE);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
		}
		// Then neither the old acknowledgement nor an old record clearer owns this newer record.
		clearStartRecoveryUnknown(oldGeneration);
		expect(startRecoveryUnknown(generation)).toBe(true);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(4);
		expect(sentCount("streaming.stop")).toBe(1);
	});
});

describe("F8 bounded Start recovery escape", () => {
	it.each([false, true])(
		"mixed false stream nudges retain Start escape %s",
		async (streaming) => {
			// Given an acknowledged Start without its confirming push.
			const { container } = render(LiveView);
			// When real mixed producer nudges supersede both successful answers.
			await exhaustStart(container, F8_MIXED_FALSE, streaming);
			expect(sentCount("streaming.stop")).toBe(0);
			await elapse(180_000);
			// Then the read budget ends in explicit UNKNOWN, not idle or an automatic Stop.
			expect(band(container)).not.toBeNull();
			expect(band(container)?.textContent).toContain(
				"Stream state not confirmed",
			);
			expect(band(container)?.textContent).toContain(
				"The device can't confirm whether a stream is still running, so starting a stream and installing updates are paused. Stop the stream to end anything that may still be running; both resume once the device confirms it has stopped.",
			);
			expect(getStreamingOptimismState()).toBe("starting");
			expect(getStatus()?.stream_lifecycle).toBe("idle");
			expect(getStatus()?.is_streaming).toBe(false);
			expect(getStatus()?.ssh).toBe(true);
			expect(getOperationPhase(KEY)).toBe("idle");
			expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
			expect(header(container)).not.toContain("Not streaming");
			expect(FakeWebSocket.log.map((r) => r.path)).toEqual([
				"streaming.start",
				"status.getStatus",
				"status.getStatus",
			]);
		},
	);

	it.each([
		["same-value false", { is_streaming: false }, "idle"],
		["lifecycle only", { stream_lifecycle: "starting" }, "starting"],
		[
			"mixed lifecycle",
			{ stream_lifecycle: "starting", active_encode: null },
			"starting",
		],
	] as const)(
		"%s supersession retains the same escape",
		async (_, push, held) => {
			// Given the real Live cockpit and a naturally partial stream-fact footprint.
			const { container } = render(LiveView);
			// When both recovery answers are stream-superseded.
			await exhaustStart(container, push);
			// Then the positive answers cannot settle, but an operator Stop is reachable.
			expect(band(container)).not.toBeNull();
			expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
			expect(getStreamingOptimismState()).toBe("starting");
			expect(getStatus()?.stream_lifecycle).toBe(held);
			expect(sentCount("status.getStatus")).toBe(2);
			expect(sentCount("streaming.stop")).toBe(0);
		},
	);

	it("an explicit acknowledged Stop clears exhausted Start and permits another Start", async () => {
		// Given an exhausted Start, still held idle with no positive post-record evidence.
		const { container } = render(LiveView);
		await exhaustStart(container);
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		// When the operator presses the band's real Stop and its own reply acknowledges it.
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual([
			{ label: "Stopping...", disabled: true },
			{ label: "Starting...", disabled: true },
		]);
		answer("streaming.stop", { success: true, result: "stopped" });
		await settle();
		// Then no held lifecycle rewrite is needed; this owner's positive Stop frees Start.
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getStreamingOptimismState()).toBe("idle");
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.stop")).toBe(1);
		expect(sentCount("status.getStatus")).toBe(2);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		expect(sentCount("streaming.start")).toBe(2);
		expect(band(container)).toBeNull();
	});

	it.each([
		[
			"live",
			{ is_streaming: true, stream_lifecycle: "streaming" },
			"streaming",
			"Stop Stream",
		],
		[
			"idle",
			{ is_streaming: false, stream_lifecycle: "idle" },
			"idle",
			"Start Stream",
		],
		[
			"idle lifecycle only",
			{ stream_lifecycle: "idle" },
			"idle",
			"Start Stream",
		],
		["idle boolean only", F8_MIXED_FALSE, "idle", "Start Stream"],
	] as const)(
		"admissible %s push settles exhausted Start without Stop",
		async (_, push, held, label) => {
			// Given an explicit recovery-unknown record after the bounded budget.
			const { container } = render(LiveView);
			await exhaustStart(container);
			expect(band(container)).not.toBeNull();
			// When genuinely later current-link stream facts say live or idle.
			deliverStatus(push);
			await settle();
			// Then the record and matching optimism clear, not backend history or another attempt.
			expect(getStreamingOptimismState()).toBe("idle");
			expect(getStatus()?.stream_lifecycle).toBe(held);
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual([{ label, disabled: false }]);
			expect(sentCount("streaming.stop")).toBe(0);
			expect(sentCount("status.getStatus")).toBe(2);
		},
	);

	it("a superseded post-record pull cannot clear recovery through disjoint hydration", async () => {
		// Given an exhausted Start and a further explicit status observation.
		const { container } = render(LiveView);
		await exhaustStart(container);
		const pending = pullStatusEvidence();
		// When both replies carry idle but follow newer non-settling stream facts.
		for (let read = 0; read < 2; read += 1) {
			deliverStatus({ stream_lifecycle: "starting" });
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
				ssh: false,
			});
			await settle();
		}
		expect(await pending).toBeUndefined();
		// Then unrelated supplied SSH still hydrates, but UNKNOWN remains actionable.
		expect(getStatus()?.ssh).toBe(false);
		expect(getStatus()?.stream_lifecycle).toBe("starting");
		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(4);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("remount and failed reconnect reads preserve the exhausted Start escape", async () => {
		// Given recovery UNKNOWN, then the destination component is removed.
		const first = render(LiveView);
		await exhaustStart(first.container);
		first.unmount();
		await settle();
		// When a replacement link's config and status reads fail before Live remounts.
		resetState();
		await reconnectAwaitingHydrate();
		reject("streaming.getConfig", "INTERNAL_ERROR");
		reject("status.getStatus", "INTERNAL_ERROR");
		await settle();
		const { container } = render(LiveView);
		await settle();
		// Then uncertainty survives component and socket lifetimes, with no automatic Stop.
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(sentCount("status.getStatus")).toBe(3);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("admissible reconnect idle settles while Live is unmounted despite config failure", async () => {
		// Given exhaustion preserved outside the destination component.
		const first = render(LiveView);
		await exhaustStart(first.container);
		first.unmount();
		await settle();
		// When the replacement link supplies independent positive idle evidence.
		await reconnectAwaitingHydrate();
		reject("streaming.getConfig", "INTERNAL_ERROR");
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		// Then settlement is store-owned, not a mounted-component side effect.
		expect(getStreamingOptimismState()).toBe("idle");
		const { container } = render(LiveView);
		await settle();
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("failed watchdog evidence also ends in an operator-actionable unknown", async () => {
		// Given acknowledged Start without a confirming push.
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await elapse(90_000);
		// When the actual read fails rather than being superseded.
		reject("status.getStatus", "INTERNAL_ERROR");
		await settle();
		// Then failure is not idle; a manual Stop is available without more reads.
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it.each([false, true])(
		"an admissible post-record pull settles Start %s",
		async (streaming) => {
			// Given UNKNOWN and a fresh actual-client observation dispatched after its claim.
			const { container } = render(LiveView);
			await exhaustStart(container);
			const pending = pullStatusEvidence();
			// When this read has no intervening stream-fact push.
			answer("status.getStatus", {
				is_streaming: streaming,
				stream_lifecycle: streaming ? "streaming" : "idle",
			});
			const received = await pending;
			if (received === undefined)
				throw new Error("post-record read must be admissible");
			ingestPulledStatus(received.status, received.receipt);
			await settle();
			// Then both ownership and overlay settle without automatic Stop.
			expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
			expect(getStreamingOptimismState()).toBe("idle");
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual([
				{ label: streaming ? "Stop Stream" : "Start Stream", disabled: false },
			]);
			expect(sentCount("status.getStatus")).toBe(3);
			expect(sentCount("streaming.stop")).toBe(0);
		},
	);

	it("an older generation cannot write or clear the second exhausted attempt", async () => {
		// Given two real exhausted attempts, separated by the first owner's acknowledged Stop.
		const { container } = render(LiveView);
		await exhaustStart(container);
		const old = getStreamingAttemptGeneration();
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		answer("streaming.stop", { success: true, result: "stopped" });
		await settle();
		await exhaustStart(container);
		const current = getStreamingAttemptGeneration();
		expect(current).toBe(old + 1);
		expect(startRecoveryUnknown(current)).toBe(true);
		// When stale callers reach the record's own API, not merely a timer wrapper.
		noteStartRecoveryUnknown(old);
		clearStartRecoveryUnknown(old);
		noteLostStartReply(old);
		noteLostStartReply(current);
		await settle();
		// Then only the second generation still owns the escape and may be settled.
		expect(startRecoveryUnknown(current)).toBe(true);
		expect(startRecoveryUnknown(old)).toBe(false);
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(4);
		expect(sentCount("streaming.stop")).toBe(1);
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		expect(startRecoveryUnknown(current)).toBe(false);
		expect(getStreamingOptimismState()).toBe("idle");
	});

	it("only the latest explicit Stop owner's acknowledgement can clear exhausted Start", async () => {
		// Given UNKNOWN and a Stop reply outliving the TTL plus its next periodic sweep.
		const { container } = render(LiveView);
		await exhaustStart(container);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(16_100);
		expect(getOperationPhase(KEY)).toBe("timed_out");
		expect(band(container)?.textContent).toContain(NOT_CONFIRMED);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		// When the earlier request acknowledges while the latest claim is still pending.
		answer("streaming.stop", { success: true, result: "stopped" }, "oldest");
		await settle();
		// Then the earlier owner clears neither this record nor matching Start optimism.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)).not.toBeNull();
		expect(getOperationPhase(KEY)).toBe("pending");
		answer("streaming.stop", { success: true, result: "stopped" }, "newest");
		await settle();
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		expect(getStreamingOptimismState()).toBe("idle");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.stop")).toBe(2);
		expect(sentCount("status.getStatus")).toBe(2);
	});

	it("failed explicit Stop and remount retain the Start record and an enabled retry", async () => {
		// Given exhausted Start and the operator's one explicit Stop.
		const first = render(LiveView);
		await exhaustStart(first.container);
		await fireEvent.click(button(first.container, "Stop Stream"));
		await settle();
		// When the device explicitly fails Stop and the Live component is replaced.
		answer("streaming.stop", STOP_FAILED_REPLY);
		await settle();
		first.unmount();
		const { container } = render(LiveView);
		await settle();
		// Then failure is honest and retry remains reachable without any new request.
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(band(container)?.textContent).toContain(FAILED);
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("streaming.stop")).toBe(1);
		expect(sentCount("status.getStatus")).toBe(2);
	});

	it("an old watchdog's undefined answer cannot mark a newer starting attempt unknown", async () => {
		// Given a first watchdog awaiting a real reply, then positive settlement and a new Start.
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await elapse(90_000);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await settle();
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		answer("streaming.stop", { success: true, result: "stopped" });
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		await fireEvent.click(button(container, "Done"));
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		// When the old request answers after its action lifetime was invalidated.
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		// Then it cannot write or settle any recovery record for the new attempt.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		expect(band(container)).toBeNull();
		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
		expect(FakeWebSocket.log.map((r) => r.path)).toEqual([
			"streaming.start",
			"status.getStatus",
			"streaming.stop",
			"streaming.start",
		]);
	});

	it("non-settling lifecycle pushes preserve recovery ownership and Start optimism", async () => {
		// Given a Start whose bounded reads exhausted evidence.
		const { container } = render(LiveView);
		await exhaustStart(container);
		const generation = getStreamingAttemptGeneration();
		// When the producer explicitly reports uncertainty, not idle or live.
		for (const lifecycle of [
			"reconciling",
			"stop_failed",
			"starting",
			"stopping",
		] as const) {
			deliverStatus({ stream_lifecycle: lifecycle });
			await settle();
			// Then that uncertainty cannot clear this matching record or optimism.
			expect(startRecoveryUnknown(generation)).toBe(true);
			expect(getStreamingOptimismState()).toBe("starting");
			expect(band(container)).not.toBeNull();
			expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		}
		expect(sentCount("streaming.stop")).toBe(0);
		expect(sentCount("status.getStatus")).toBe(2);
	});

	it("config failure and twice-superseded replacement-link hydration preserve recovery", async () => {
		// Given UNKNOWN persisted before the link changes.
		const { container } = render(LiveView);
		await exhaustStart(container);
		await reconnectAwaitingHydrate();
		reject("streaming.getConfig", "INTERNAL_ERROR");
		await settle();
		// When BOTH replacement-link status reads are superseded by real mixed lifecycle nudges.
		for (let read = 0; read < 2; read += 1) {
			await elapse(1_100);
			deliverStatus({
				stream_lifecycle: "starting",
				active_encode: null,
				engine_bitrate: null,
				preview_encoder_realized: null,
			});
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
				ssh: true,
			});
			await settle();
		}
		// Then neither independent config failure nor successful stale status means idle.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(getStreamingOptimismState()).toBe("starting");
		expect(getStatus()?.stream_lifecycle).toBe("starting");
		expect(getStatus()?.ssh).toBe(true);
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(4);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("a drop during the watchdog read publishes unknown without automatic Stop", async () => {
		// Given acknowledged Start and the first real watchdog read in flight.
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await elapse(90_000);
		// When the socket rejects the outstanding read on replacement.
		dropLink();
		await settle();
		// Then this current attempt owns an actionable UNKNOWN across the outage.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("true mixed nudges settle Start rather than manufacturing or doubling a recovery Stop", async () => {
		// Given acknowledged Start and its current bounded read in flight.
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await elapse(90_000);
		// When current positive streaming facts supersede the read (including same-value nudges).
		deliverStatus({ ...F8_MIXED_FALSE, is_streaming: true });
		await settle();
		deliverStatus({ ...F8_MIXED_FALSE, is_streaming: true });
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		// Then positive push evidence ends the current action, so no exhaustion record is warranted.
		expect(getStreamingOptimismState()).toBe("idle");
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
		]);
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it.each([390, 1280])(
		"recovery Stop retains phone/desktop and RTL actionable markup at %spx",
		async (width) => {
			// Given either viewport contract and RTL direction (jsdom does not prove geometry).
			const previousWidth = window.innerWidth;
			const previousDirection = document.documentElement.dir;
			Object.defineProperty(window, "innerWidth", { value: width });
			document.documentElement.dir = "rtl";
			try {
				const { container } = render(LiveView);
				// When Start exhausts its real bounded reads.
				await exhaustStart(container);
				// Then one enabled Stop remains in the normal scrollable content with responsive touch markup.
				const stop = button(container, "Stop Stream");
				expect(stop.disabled).toBe(false);
				expect(stop.classList.contains("min-h-[44px]")).toBe(true);
				expect(stop.classList.contains("w-full")).toBe(true);
				expect(stop.classList.contains("sm:w-auto")).toBe(true);
				expect(stop.closest('[data-testid="unconfirmed-stream-band"]')).toBe(
					band(container),
				);
				expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
				expect(band(container)?.getAttribute("aria-live")).toBe("polite");
				expect(sentCount("streaming.stop")).toBe(0);
			} finally {
				Object.defineProperty(window, "innerWidth", { value: previousWidth });
				document.documentElement.dir = previousDirection;
			}
		},
	);

	it("the real NavigationRenderer retains exhausted Start recovery after leaving and returning", async () => {
		// Given the real destination renderer, real socket and an exhausted Start.
		publishNavigation({ live: { component: LiveView } });
		const { container } = render(NavigationRenderer);
		await exhaustStart(container);
		// When navigation replaces Live with another destination, then returns without settlement.
		publishNavigation({ network: { component: Noop } });
		flushSync();
		await elapse(1_000);
		expect(controls(container)).toEqual([]);
		deliverStatus({ stream_lifecycle: "starting", ssh: false });
		await settle();
		publishNavigation({ live: { component: LiveView } });
		flushSync();
		await elapse(1_000);
		// Then the app-wide record still owns one enabled Stop in the remounted real cockpit.
		expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(true);
		expect(band(container)).not.toBeNull();
		expect(controls(container)).toEqual(F8_RECOVERY_CONTROLS);
		expect(sentCount("status.getStatus")).toBe(2);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it.each([false, true])(
		"stream facts settle exhausted Start while actually navigated away %s",
		async (streaming) => {
			// Given the real destination replacement after Start recovery became UNKNOWN.
			publishNavigation({ live: { component: LiveView } });
			const { container } = render(NavigationRenderer);
			await exhaustStart(container);
			publishNavigation({ network: { component: Noop } });
			flushSync();
			await elapse(1_000);
			expect(controls(container)).toEqual([]);
			// When an admitted current-link positive delivery reaches subscriptions while Live is absent.
			deliverStatus({
				is_streaming: streaming,
				stream_lifecycle: streaming ? "streaming" : "idle",
			});
			await settle();
			// Then ownership settles immediately, and navigation back cannot resurrect UNKNOWN.
			expect(startRecoveryUnknown(getStreamingAttemptGeneration())).toBe(false);
			expect(getStreamingOptimismState()).toBe("idle");
			publishNavigation({ live: { component: LiveView } });
			flushSync();
			await elapse(1_000);
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual([
				{ label: streaming ? "Stop Stream" : "Start Stream", disabled: false },
			]);
			expect(sentCount("streaming.stop")).toBe(0);
			expect(sentCount("status.getStatus")).toBe(2);
		},
	);
});

describe("F7 independent stream evidence and field freshness", () => {
	it("a stream-superseded idle pull cannot perform implicit live-field clears", async () => {
		// Given live telemetry preceding a read that an actual stream push supersedes.
		const real = await vi.importActual<
			typeof import("../lib/rpc/subscriptions.svelte")
		>("../lib/rpc/subscriptions.svelte");
		const telemetry = { links: [], measured_bps: 0, lastReadMs: Date.now() };
		deliverStatus({
			is_streaming: true,
			stream_lifecycle: "streaming",
			linkTelemetry: telemetry,
		});
		const pending = pullStatusEvidence();
		deliverStatus({ stream_lifecycle: "stopping" });
		await settle();
		// When an old idle reply arrives, its SSH field still hydrates, not its clears.
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: true,
		});
		await settle();
		expect(getStatus()?.ssh).toBe(true);
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(getStatus()?.is_streaming).toBe(true);
		expect(real.getLinkTelemetry()).toEqual(telemetry);
		reject("status.getStatus", "INTERNAL_ERROR");
		await expect(pending).rejects.toBeInstanceOf(Error);
		expect(sentCount("status.getStatus")).toBe(2);
		expect(sentCount("streaming.stop")).toBe(0);
	});
	it("a buffered old-link answer cannot merge unrelated fields on the replacement link", async () => {
		// Given a successful actual-client answer held before a link replacement.
		const pending = pullStatusEvidence();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: true,
		});
		const buffered = await pending;
		if (buffered === undefined)
			throw new Error("read must land before the drop");
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: false,
		});
		await settle();
		// When the old receipt is ingested late, neither group has link authority.
		ingestPulledStatus(buffered.status, buffered.receipt);
		await settle();
		expect(getStatus()?.ssh).toBe(false);
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("a buffered answer preserves a newer unrelated push and hydrates disjoint fields", async () => {
		// Given an actual received answer held before a newer SSH push.
		const pending = pullStatusEvidence();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: true,
			wifi: F7_WIFI,
		});
		const buffered = await pending;
		if (buffered === undefined) throw new Error("read must be received");
		deliverStatus({ ssh: false });
		await settle();
		// When consumed later, receipt ordering protects SSH without losing Wi-Fi.
		ingestPulledStatus(buffered.status, buffered.receipt);
		await settle();
		expect(getStatus()?.ssh).toBe(false);
		expect(getStatus()?.wifi).toEqual(F7_WIFI);
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("a pulled Stop cannot clear newer telemetry through the derived stop edge", async () => {
		// Given a live stream and a status read interrupted by newer telemetry.
		const real = await vi.importActual<
			typeof import("../lib/rpc/subscriptions.svelte")
		>("../lib/rpc/subscriptions.svelte");
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		const pending = pullStatusEvidence();
		const telemetry = { links: [], measured_bps: 0, lastReadMs: Date.now() };
		deliverStatus({ linkTelemetry: telemetry });
		await settle();
		// When the admissible stream answer triggers implicit telemetry retraction.
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		const result = await pending;
		if (result === undefined)
			throw new Error("telemetry cannot supersede stream facts");
		ingestPulledStatus(result.status, result.receipt);
		await settle();
		expect(real.getLinkTelemetry()).toEqual(telemetry);
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it.each([
		[true, "streaming", [{ label: "Stop Stream", disabled: false }]],
		[false, "idle", [{ label: "Start Stream", disabled: false }]],
	] as const)(
		"unrelated telemetry must not eat positive Start evidence %s",
		async (streaming, lifecycle, expectedControls) => {
			// Given an acknowledged Start whose confirming push is missing.
			const { container } = render(LiveView);
			await fireEvent.click(button(container, "Start Stream"));
			await settle();
			answer("streaming.start", { success: true });
			await settle();
			await elapse(90_000);
			expect(outstanding("status.getStatus")).toHaveLength(1);
			// When telemetry arrives while the watchdog's real read is in flight.
			await elapse(1_100);
			deliverStatus({ linkTelemetry: null, bond_mapping: null });
			await settle();
			answer("status.getStatus", {
				is_streaming: streaming,
				stream_lifecycle: lifecycle,
			});
			await settle();
			if (outstanding("status.getStatus").length > 0) {
				await elapse(1_100);
				deliverStatus({ linkTelemetry: null, bond_mapping: null });
				await settle();
				answer("status.getStatus", {
					is_streaming: streaming,
					stream_lifecycle: lifecycle,
				});
				await settle();
			}
			// Then one successful read reconciles; no replacement or automatic Stop.
			expect(getStreamingOptimismState()).toBe("idle");
			expect(getStatus()?.stream_lifecycle).toBe(lifecycle);
			expect(getOperationPhase(KEY)).toBe("idle");
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual(expectedControls);
			expect(sentCount("status.getStatus")).toBe(1);
			await elapse(180_000);
			expect(controls(container)).toEqual(expectedControls);
			expect(FakeWebSocket.log.map((r) => r.path)).toEqual([
				"streaming.start",
				"status.getStatus",
			]);
		},
	);

	it.each([
		{ linkTelemetry: null, bond_mapping: null },
		{ wifi: {}, modems: {} },
	])(
		"disjoint partial pushes cannot discard SSH hydration %j",
		async (push) => {
			// Given no stream claim, SSH false, and a full reconnect read in flight.
			const { container } = render(LiveView);
			deliverStatus({ ssh: false });
			await reconnectAwaitingHydrate();
			answer("streaming.getConfig", {});
			await settle();
			await elapse(1_100);
			deliverStatus(push);
			await settle();
			// When a successful read supplies an unchanged-by-push field.
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
				ssh: true,
			});
			await settle();
			// Then the supplied value is not lost to disjoint activity.
			expect(getStatus()?.ssh).toBe(true);
			expect(getStatus()?.stream_lifecycle).toBe("idle");
			expect(getOperationPhase(KEY)).toBe("idle");
			expect(band(container)).toBeNull();
			expect(controls(container)).toEqual([
				{ label: "Start Stream", disabled: false },
			]);
			expect(sentCount("status.getStatus")).toBe(1);
			expect(sentCount("streaming.stop")).toBe(0);
		},
	);

	it.each([
		[
			"mixed stream fact",
			{ linkTelemetry: null, stream_lifecycle: "stopping" },
		],
		["unknown field fails closed", { future_stream_fact: "stopping" }],
	] as const)(
		"%s supersedes stream facts but retains unrelated fields",
		async (_, push) => {
			// Given a pending operator Stop and a genuinely post-claim read.
			const { container } = render(LiveView);
			deliverStatus({
				is_streaming: false,
				stream_lifecycle: "stop_failed",
				ssh: false,
			});
			await fireEvent.click(button(container, "Stop Stream"));
			await settle();
			deliverStatus({ stream_lifecycle: "stopping" });
			const pulled = pullStatusEvidence().then((answer) => {
				if (answer !== undefined)
					ingestPulledStatus(answer.status, answer.receipt);
				return answer;
			});
			await settle();
			// When BOTH reads are superseded for stream facts, not SSH/Wi-Fi/modems.
			deliverStatus(push);
			await settle();
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
				ssh: true,
				wifi: F7_WIFI,
				modems: F7_MODEMS,
			});
			await settle();
			expect(getStatus()?.ssh).toBe(true);
			expect(getStatus()?.wifi).toEqual(F7_WIFI);
			expect(getStatus()?.modems).toEqual(F7_MODEMS);
			expect(getStatus()?.stream_lifecycle).toBe("stopping");
			expect(getOperationPhase(KEY)).toBe("pending");
			expect(band(container)).not.toBeNull();
			expect(controls(container)).toEqual(STOPPING_AND_START);
			expect(outstanding("status.getStatus")).toHaveLength(1);
			deliverStatus({ stream_lifecycle: "stopping", wifi: {} });
			await settle();
			answer("status.getStatus", {
				is_streaming: true,
				stream_lifecycle: "streaming",
				ssh: true,
				wifi: F7_WIFI,
				modems: F7_MODEMS,
			});
			await settle();
			expect(await pulled).toBeUndefined();
			expect(getStatus()?.is_streaming).toBe(false);
			expect(getStatus()?.stream_lifecycle).toBe("stopping");
			expect(getStatus()?.ssh).toBe(true);
			expect(getStatus()?.wifi).toEqual({});
			expect(getStatus()?.modems).toEqual(F7_MODEMS);
			expect(getOperationPhase(KEY)).toBe("pending");
			expect(sentCount("status.getStatus")).toBe(2);
			expect(sentCount("streaming.stop")).toBe(1);
			if ("future_stream_fact" in push) {
				expect(
					Object.entries(getStatus() ?? {}).find(
						([k]) => k === "future_stream_fact",
					),
				).toEqual(["future_stream_fact", "stopping"]);
			}
			answer("streaming.stop", STOP_FAILED_REPLY);
			await settle();
			expect(getOperationPhase(KEY)).toBe("failed");
			expect(band(container)?.textContent).toContain(FAILED);
		},
	);

	it.each([
		["ssh", false, true, "before dispatch"],
		["ssh", false, true, "after dispatch"],
		["ssh", false, true, "after answer"],
		["wifi", {}, F7_WIFI, "before dispatch"],
		["wifi", {}, F7_WIFI, "after dispatch"],
		["wifi", {}, F7_WIFI, "after answer"],
		["modems", {}, F7_MODEMS, "before dispatch"],
		["modems", {}, F7_MODEMS, "after dispatch"],
		["modems", {}, F7_MODEMS, "after answer"],
	] as const)(
		"%s push %s -> %s (%s) preserves per-field order",
		async (field, pushed, read, order) => {
			// Given an unrelated field update on either side of a real read.
			render(LiveView);
			if (order === "before dispatch") deliverStatus({ [field]: pushed });
			const pulled = pullStatusEvidence();
			await settle();
			if (order === "after dispatch") deliverStatus({ [field]: pushed });
			await settle();
			// When the full answer is ingested through its actual dispatch/receipt.
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
				[field]: read,
			});
			const result = await pulled;
			if (result === undefined)
				throw new Error("unrelated push must not supersede stream evidence");
			ingestPulledStatus(result.status, result.receipt);
			await settle();
			if (order === "after answer") deliverStatus({ [field]: pushed });
			await settle();
			// Then only a pre-dispatch push is replaced by this snapshot.
			expect(getStatus()?.[field]).toEqual(
				order === "before dispatch" ? read : pushed,
			);
			expect(getStatus()?.stream_lifecycle).toBe("idle");
			expect(sentCount("status.getStatus")).toBe(1);
			expect(sentCount("streaming.stop")).toBe(0);
		},
	);

	it("overlapping pulls keep later fields and still merge disjoint older fields", async () => {
		// Given two actual outstanding reads, with a partial push between them.
		render(LiveView);
		const older = pullStatusEvidence();
		await settle();
		deliverStatus({ linkTelemetry: null });
		const newer = pullStatusEvidence();
		await settle();
		// When the later-dispatched answer lands first, the older one is stream-stale.
		answer(
			"status.getStatus",
			{ is_streaming: false, stream_lifecycle: "idle", wifi: F7_WIFI },
			"newest",
		);
		const latest = await newer;
		if (latest === undefined) throw new Error("later read must be current");
		ingestPulledStatus(latest.status, latest.receipt);
		await settle();
		answer("status.getStatus", {
			is_streaming: true,
			stream_lifecycle: "streaming",
			ssh: true,
			wifi: {},
		});
		await settle();
		expect(getStatus()?.ssh).toBe(true);
		expect(getStatus()?.wifi).toEqual(F7_WIFI);
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		// A replacement, not a third read for this cycle; failed read grants nothing.
		reject("status.getStatus", "INTERNAL_ERROR");
		await expect(older).rejects.toBeInstanceOf(Error);
		expect(sentCount("status.getStatus")).toBe(3);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("resetState keeps field ordering and a link replacement rejects the old pull", async () => {
		// Given an in-flight read, then a store reset and a newer SSH push.
		const pulled = pullStatusEvidence();
		await settle();
		resetState();
		deliverStatus({ ssh: false });
		// When the snapshot arrives on the same link.
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: true,
			modems: F7_MODEMS,
		});
		const result = await pulled;
		if (result === undefined)
			throw new Error("disjoint push is not stream supersession");
		ingestPulledStatus(result.status, result.receipt);
		await settle();
		expect(getStatus()?.ssh).toBe(false);
		expect(getStatus()?.modems).toEqual(F7_MODEMS);
		// The next read cannot carry that authority across a replacement link.
		const dropped = pullStatusEvidence();
		const rejection = expect(dropped).rejects.toBeInstanceOf(Error);
		dropLink();
		await settle();
		await rejection;
		await restoreLink();
		answer("auth.login", { success: true });
		await settle();
		answer("streaming.getConfig", {});
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			ssh: true,
		});
		await settle();
		expect(getStatus()?.ssh).toBe(true);
		expect(sentCount("streaming.stop")).toBe(0);
	});

	it("lost Start and Stop replies reconcile only from the next link's stream evidence", async () => {
		// Given a lost Start, then an affirmative Stop whose reply is also lost.
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		deliverStatus({ is_streaming: false, stream_lifecycle: "reconciling" });
		await settle();
		expect(getStreamingOptimismState()).toBe("idle");
		expect(controls(container)).toEqual(STOP_AND_START);
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		deliverStatus({ stream_lifecycle: "stopping" });
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		await settle();
		// When unrelated telemetry interrupts the new link's post-claim hydrate.
		deliverStatus({ linkTelemetry: null, bond_mapping: null, ssh: false });
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)).not.toBeNull();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
			wifi: F7_WIFI,
		});
		await settle();
		// Then positive stream evidence clears only the unresolved claims.
		expect(getStreamingOptimismState()).toBe("idle");
		expect(getStatus()?.stream_lifecycle).toBe("idle");
		expect(getStatus()?.ssh).toBe(false);
		expect(getStatus()?.wifi).toEqual(F7_WIFI);
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual([
			{ label: "Start Stream", disabled: false },
		]);
		expect(sentCount("streaming.start")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(1);
		expect(sentCount("status.getStatus")).toBe(2);
	});
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
		// F6 contract correction: the first request preceded the claim. Only the
		// bounded replacement read, SENT after it, can confirm this Stop.
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(controls(container)).toEqual(STOPPING_AND_START);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		const [fresh] = outstanding("status.getStatus");
		const [stop] = outstanding("streaming.stop");
		if (fresh === undefined || stop === undefined)
			throw new Error("requests missing");
		expect(
			FakeWebSocket.log.findIndex((r) => r.id === fresh.id),
		).toBeGreaterThan(FakeWebSocket.log.findIndex((r) => r.id === stop.id));
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
		// Preserve the recovery expectation, but require a fresh dispatch AFTER
		// the observation rather than certify the superseded read as newer.
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(outstanding("status.getStatus")).toHaveLength(1);
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

describe("F6 request causality and action lifetime over the real socket", () => {
	it.each([
		[true, true, true, "pending", 2],
		[true, true, false, "pending", 2],
		[true, false, true, "pending", 2],
		[true, false, false, "pending", 2],
		[false, true, true, "pending", 2],
		[false, true, false, "pending", 2],
		[false, false, true, "confirmed", 1],
		[false, false, false, "confirmed", 1],
	] as const)(
		"ordering matrix preclaim=%s push-first=%s config-first=%s",
		async (preclaim, pushFirst, configFirst, phase, reads) => {
			const { container } = render(LiveView);
			deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
			dropLink();
			await settle();
			await restoreLink();
			const log = recordOperationPhases(KEY);
			if (preclaim) {
				answer("auth.login", { success: true });
				await settle();
			}
			await fireEvent.click(button(container, "Stop Stream"));
			await settle();
			if (!preclaim) {
				answer("auth.login", { success: true });
				await settle();
			}
			const [read] = outstanding("status.getStatus");
			const [stop] = outstanding("streaming.stop");
			if (read === undefined || stop === undefined)
				throw new Error("requests missing");
			const readIndex = FakeWebSocket.log.findIndex((r) => r.id === read.id);
			const stopIndex = FakeWebSocket.log.findIndex((r) => r.id === stop.id);
			if (preclaim) expect(readIndex).toBeLessThan(stopIndex);
			else expect(readIndex).toBeGreaterThan(stopIndex);
			if (configFirst) {
				answer("streaming.getConfig", {});
				await settle();
			}
			if (pushFirst) deliverStatus({ stream_lifecycle: "stopping" });
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
			expect(getOperationPhase(KEY)).toBe(phase);
			expect(sentCount("status.getStatus")).toBe(reads);
			if (phase === "pending") {
				expect(band(container)).not.toBeNull();
				expect(controls(container)).toEqual(STOPPING_AND_START);
			} else {
				expect(band(container)).toBeNull();
				expect(controls(container)).toEqual(START_ONLY);
			}
			if (!pushFirst) deliverStatus({ stream_lifecycle: "stopping" });
			deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
			if (outstanding("status.getStatus").length)
				answer("status.getStatus", {
					is_streaming: false,
					stream_lifecycle: "idle",
				});
			if (!configFirst) answer("streaming.getConfig", {});
			await settle();
			answer("streaming.stop", { result: "stopped", success: true });
			await settle();
			expect(log.phases).toEqual(["idle", "pending", "confirmed"]);
			log.stop();
			expect(sentCount("streaming.stop")).toBe(1);
			expect(sentCount("status.getStatus")).toBe(reads);
			expect(getStatus()?.stream_lifecycle).toBe("idle");
			expect(controls(container)).toEqual(START_ONLY);
		},
	);

	it("a new Stop watchdog is not blocked or released by an older awaited cycle", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(15_000);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		answer("streaming.stop", { result: "stopped", success: true });
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		await fireEvent.click(button(container, "Done"));
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await settle();
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(15_000);
		expect(outstanding("status.getStatus")).toHaveLength(2);
		answer(
			"status.getStatus",
			{ is_streaming: true, stream_lifecycle: "streaming" },
			"oldest",
		);
		await settle();
		expect(sentCount("streaming.stop")).toBe(2);
		expect(getStreamingOptimismState()).toBe("stopping");
		answer(
			"status.getStatus",
			{ is_streaming: false, stream_lifecycle: "idle" },
			"newest",
		);
		await settle();
		expect(getStreamingOptimismState()).toBe("idle");
		expect(sentCount("streaming.stop")).toBe(2);
	});

	it("a Stop settled during repull delay never reads or stops the next session", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(15_000);
		answer("status.getStatus", {
			is_streaming: true,
			stream_lifecycle: "streaming",
		});
		await settle();
		expect(sentCount("streaming.stop")).toBe(2);
		answer("streaming.stop", { result: "stopped", success: true }, "oldest");
		answer("streaming.stop", { result: "stopped", success: true }, "newest");
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		await fireEvent.click(button(container, "Done"));
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await settle();
		await elapse(2_000);
		expect(sentCount("status.getStatus")).toBe(1);
		expect(sentCount("streaming.stop")).toBe(2);
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
		]);
	});

	for (const statusFails of [false, true]) {
		it(`restoration rereads real dialog details/settings/capabilities (status fails=${statusFails})`, async () => {
			deliverStatus({
				update_orchestrator: {
					schema: 1,
					phase: "idle",
					progress: null,
					failure_reason: null,
					cellular_override_id: null,
				},
			});
			render(UpdatesDialog, { open: true });
			await settle();
			const reads = [
				"system.getUpdateCapabilities",
				"system.getUpdateSettings",
				"system.getUpdateDetails",
			];
			for (const [path, value] of [
				[reads[0], CAPABLE],
				[reads[1], SETTINGS],
				[reads[2], deviceDetails()],
			] as const) {
				if (path === undefined) throw new Error("missing path");
				while (outstanding(path).length) answer(path, value);
			}
			await settle();
			const before = reads.map(sentCount);
			const restored = getRestoredSessions();
			await reconnectAwaitingHydrate();
			if (statusFails) reject("status.getStatus", "INTERNAL_ERROR");
			else
				answer("status.getStatus", {
					is_streaming: false,
					stream_lifecycle: "idle",
				});
			await settle();
			expect(getRestoredSessions()).toBe(restored);
			expect(reads.map(sentCount)).toEqual(before);
			answer("streaming.getConfig", {});
			await settle();
			expect(getRestoredSessions()).toBe(restored + 1);
			expect(reads.map(sentCount)).toEqual(before.map((n) => n + 1));
		});
	}

	it("a drop during the bounded reread never settles Stop and a new hydrate owns the next link", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(sentCount("status.getStatus")).toBe(2);
		dropLink();
		await settle();
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(band(container)?.textContent).toContain(FAILED);
		await restoreLink();
		answer("auth.login", { success: true });
		await settle();
		expect(sentCount("status.getStatus")).toBe(3);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		answer("streaming.getConfig", {});
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(band(container)).toBeNull();
		expect(controls(container)).toEqual(START_ONLY);
		expect(sentCount("streaming.stop")).toBe(1);
	});

	for (const pushed of [false, true]) {
		it(`a preclaim request cannot swallow Stop failure (newer push=${pushed})`, async () => {
			const { container } = render(LiveView);
			deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
			await reconnectAwaitingHydrate();
			const [read] = outstanding("status.getStatus");
			answer("streaming.getConfig", {});
			await settle();
			await fireEvent.click(button(container, "Stop Stream"));
			await settle();
			const [stop] = outstanding("streaming.stop");
			if (read === undefined || stop === undefined)
				throw new Error("requests missing");
			expect(FakeWebSocket.log.findIndex((r) => r.id === read.id)).toBeLessThan(
				FakeWebSocket.log.findIndex((r) => r.id === stop.id),
			);
			if (pushed) deliverStatus({ stream_lifecycle: "stopping" });
			answer("status.getStatus", {
				is_streaming: false,
				stream_lifecycle: "idle",
			});
			await settle();
			expect(getOperationPhase(KEY)).toBe("pending");
			expect(getStatus()?.stream_lifecycle).toBe(
				pushed ? "stopping" : "stop_failed",
			);
			expect(band(container)).not.toBeNull();
			expect(controls(container)).toEqual(STOPPING_AND_START);
			answer("streaming.stop", STOP_FAILED_REPLY);
			await settle();
			expect(getOperationPhase(KEY)).toBe("failed");
			expect(band(container)?.textContent).toContain(FAILED);
			expect(header(container)).not.toContain("Not streaming");
			expect(controls(container)).toEqual(STOP_AND_START);
			expect(sentCount("streaming.stop")).toBe(1);
		});
	}

	it("a twice-superseded hydrate issues only one fresh read and settles nothing", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: false, stream_lifecycle: "stop_failed" });
		await reconnectAwaitingHydrate();
		answer("streaming.getConfig", {});
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(sentCount("status.getStatus")).toBe(2);
		deliverStatus({ stream_lifecycle: "stopping" });
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(sentCount("status.getStatus")).toBe(2);
		expect(outstanding("status.getStatus")).toHaveLength(0);
		expect(getStatus()?.stream_lifecycle).toBe("stopping");
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(controls(container)).toEqual(STOPPING_AND_START);
		expect(sentCount("streaming.stop")).toBe(1);
	});

	it("a completed Stop watchdog never stops the next live session", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(15_000);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		answer("streaming.stop", { result: "stopped", success: true });
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		await fireEvent.click(button(container, "Done"));
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await settle();
		answer("status.getStatus", {
			is_streaming: true,
			stream_lifecycle: "streaming",
		});
		await settle();
		expect(
			FakeWebSocket.log
				.filter((r) =>
					["streaming.stop", "status.getStatus", "streaming.start"].includes(
						r.path,
					),
				)
				.map((r) => r.path),
		).toEqual(["streaming.stop", "status.getStatus", "streaming.start"]);
		expect(getStreamingOptimismState()).toBe("idle");
		expect(controls(container)).toEqual([
			{ label: "Stop Stream", disabled: false },
		]);
		expect(band(container)).toBeNull();
	});

	it("a completed Start watchdog never reverts the next starting attempt", async () => {
		const { container } = render(LiveView);
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		answer("streaming.start", { success: true });
		await settle();
		await elapse(90_000);
		expect(outstanding("status.getStatus")).toHaveLength(1);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		answer("streaming.stop", { result: "stopped", success: true });
		deliverStatus({ is_streaming: false, stream_lifecycle: "idle" });
		await settle();
		await fireEvent.click(button(container, "Done"));
		await settle();
		await fireEvent.click(button(container, "Start Stream"));
		await settle();
		expect(getStreamingOptimismState()).toBe("starting");
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(getStreamingOptimismState()).toBe("starting");
		expect(controls(container)).toEqual([
			{ label: "Starting...", disabled: true },
		]);
		expect(sentCount("streaming.start")).toBe(2);
		expect(sentCount("streaming.stop")).toBe(1);
		expect(sentCount("status.getStatus")).toBe(1);
	});

	it("a still-current operator Stop watchdog redispatches exactly once", async () => {
		const { container } = render(LiveView);
		deliverStatus({ is_streaming: true, stream_lifecycle: "streaming" });
		await fireEvent.click(button(container, "Stop Stream"));
		await settle();
		await elapse(15_000);
		answer("status.getStatus", {
			is_streaming: true,
			stream_lifecycle: "streaming",
		});
		await settle();
		expect(sentCount("streaming.stop")).toBe(2);
		answer("streaming.stop", { result: "stopped", success: true }, "newest");
		await elapse(2_000);
		answer("status.getStatus", {
			is_streaming: false,
			stream_lifecycle: "idle",
		});
		await settle();
		expect(sentCount("streaming.stop")).toBe(2);
		expect(getStreamingOptimismState()).toBe("idle");
		expect(header(container)).toContain("Not streaming");
	});
});
