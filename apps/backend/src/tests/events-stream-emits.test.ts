import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as events from "../modules/events/emit.ts";
import * as armed from "../modules/streaming/armed-stream-marker.ts";
import {
	initEngineConnection,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import {
	evaluateIndicator,
	reportEngineState,
	resetLifecycleIndicatorState,
} from "../modules/streaming/lifecycle-indicators.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	StreamStartFailure,
	typedStartFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";
import {
	getStreamLifecycleState,
	seedStreamLifecycleState,
} from "../modules/streaming/stream-lifecycle-status.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import {
	createStreamSessionOrchestrator,
	type StreamSessionOrchestratorDeps,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	reportStartRetry,
	reportStartTerminalFailure,
} from "../modules/streaming/stream-start-retry-reporting.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	AUTOSTART_MAX_LINK_ATTEMPTS,
	autoStartStream,
} from "../modules/streaming/streamloop/autostart.ts";

let emit: ReturnType<typeof spyOn<typeof events, "emitEvent">>;
let stopped: ReturnType<typeof spyOn<typeof armed, "noteStreamStopped">>;

beforeEach(() => {
	emit = spyOn(events, "emitEvent").mockImplementation(() => {});
	stopped = spyOn(armed, "noteStreamStopped").mockImplementation(() => {});
	seedStreamLifecycleState("idle");
	resetLifecycleIndicatorState();
});

afterEach(() => {
	stopEngineReconnect();
	resetLifecycleIndicatorState();
	emit.mockRestore();
	stopped.mockRestore();
	seedStreamLifecycleState("idle");
});

function session(overrides: Partial<StreamSessionOrchestratorDeps> = {}) {
	return createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		initialLiveness: "idle",
		createAttemptId: () => "event-attempt",
		setStreamingStatus: () => {},
		getStreamingStatus: () => true,
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => ({
			admitted: true,
			lease: { holder: "streaming", release: () => {} },
		}),
		awaitRecovery: async () => {},
		recoveryPending: () => false,
		blockingMutation: () => undefined,
		admitUpdate: async () => ({ allowed: true }),
		markStreamingForOta: () => true,
		unmarkStreamingForOta: () => true,
		onStreamCommitted: () => {},
		onStreamArmed: () => {},
		...overrides,
	});
}

test("start then operator stop records the pair with elapsed seconds and preserves marker bookkeeping", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(10_000);
	try {
		const h = session();
		expect(
			await h.start({ origin: "ui", launch: async () => {} }),
		).toMatchObject({
			result: "started",
		});
		clock.mockReturnValue(12_500);
		expect(await h.stop("operator")).toEqual({ result: "stopped" });
		expect(emit.mock.calls).toEqual([
			["stream_started", {}],
			["stream_stopped", { cause: "operator", durationSec: 2.5 }],
		]);
		expect(stopped).toHaveBeenCalledWith("operator");
		expect(getStreamLifecycleState()).toBe("idle");
	} finally {
		clock.mockRestore();
	}
});

test("reconciliation adopts streaming without recording another start", async () => {
	const h = session({ queryRuntime: async () => "streaming" });
	await h.reconcile();
	await h.reconcile();
	expect(getStreamLifecycleState()).toBe("streaming");
	expect(emit.mock.calls).toEqual([]);
});

test("same-state streaming publication does not record a start", () => {
	seedStreamLifecycleState("streaming");
	streamSessionProductionDeps.setLifecycleState?.("streaming");
	expect(emit.mock.calls).toEqual([]);
});

test("stopping an adopted session uses zero for an unobserved start", async () => {
	const h = session({ queryRuntime: async () => "streaming" });
	await h.reconcile();
	await h.stop("engine_loss");
	expect(emit.mock.calls).toEqual([
		["stream_stopped", { cause: "engine_loss", durationSec: 0 }],
	]);
});

test("a new lifecycle seed forgets a prior session's elapsed time", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(10_000);
	try {
		const prior = session();
		await prior.start({ origin: "ui", launch: async () => {} });
		clock.mockReturnValue(20_000);
		const h = session({ queryRuntime: async () => "streaming" });
		await h.reconcile();
		await h.stop("operator");
		expect(emit.mock.calls.at(-1)).toEqual([
			"stream_stopped",
			{ cause: "operator", durationSec: 0 },
		]);
	} finally {
		clock.mockRestore();
	}
});

test("repeated stop intent has no retained duration", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(10_000);
	try {
		const h = session();
		await h.start({ origin: "ui", launch: async () => {} });
		clock.mockReturnValue(20_000);
		await h.stop("operator");
		clock.mockReturnValue(30_000);
		await h.stop("operator");
		expect(emit.mock.calls.at(-1)).toEqual([
			"stream_stopped",
			{ cause: "operator", durationSec: 0 },
		]);
	} finally {
		clock.mockRestore();
	}
});

test("a backward wall clock step cannot produce a negative duration", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(10_000);
	try {
		const h = session();
		await h.start({ origin: "ui", launch: async () => {} });
		clock.mockReturnValue(9000);
		await h.stop("operator");
		expect(emit.mock.calls.at(-1)).toEqual([
			"stream_stopped",
			{ cause: "operator", durationSec: 0 },
		]);
	} finally {
		clock.mockRestore();
	}
});

test("terminal launch failure records taxonomy and never records a start", async () => {
	const h = session();
	await h.start({
		origin: "ui",
		launch: async ({ attemptId }) => {
			throw new StreamStartFailure(
				typedStartFailure(attemptId, "start-rpc", "start_invalid", "invalid"),
			);
		},
	});
	expect(emit.mock.calls).toEqual([
		[
			"stream_start_failed",
			{
				class: "start_invalid",
				phase: "start-rpc",
				attempt: 1,
				maxAttempts: 5,
			},
		],
	]);
});

test("terminal capture refusal includes its typed cause and excludes raw diagnostics", () => {
	reportStartTerminalFailure({
		attemptId: "private-attempt",
		class: "capture_source_unavailable",
		phase: "start-rpc",
		captureCause: "no_signal",
		code: "private-code",
		message: "private-destination",
		retry: {
			state: "not_retriable",
			attempt: 2,
			maxAttempts: 4,
			suppressed: false,
		},
	});
	expect(emit.mock.calls).toEqual([
		[
			"stream_start_failed",
			{
				class: "capture_source_unavailable",
				phase: "start-rpc",
				captureCause: "no_signal",
				attempt: 2,
				maxAttempts: 4,
			},
		],
	]);
});

test.each([false, true])(
	"scheduled retry records taxonomy even when notification suppression is %s",
	(suppressed) => {
		reportStartRetry({
			attemptId: "private-attempt",
			class: "engine_unavailable",
			phase: "connect",
			retry: {
				state: "scheduled",
				attempt: 2,
				nextAttempt: 3,
				maxAttempts: 4,
				delayMs: 1000,
				suppressed,
			},
		});
		expect(emit.mock.calls).toEqual([
			[
				"stream_start_retrying",
				{
					class: "engine_unavailable",
					phase: "connect",
					attempt: 2,
					maxAttempts: 4,
				},
			],
		]);
	},
);

test("a terminal diagnostic handed to the retry reporter is not a retry", () => {
	reportStartRetry({
		attemptId: "private-attempt",
		class: "engine_unavailable",
		phase: "connect",
		retry: {
			state: "exhausted",
			attempt: 5,
			maxAttempts: 5,
			suppressed: false,
		},
	});
	expect(emit.mock.calls).toEqual([]);
});

test("failed stop records the failure edge without changing lifecycle", async () => {
	const h = session({
		stopRuntime: async () => {
			throw new Error("stop refused");
		},
	});
	await h.start({ origin: "ui", launch: async () => {} });
	emit.mockClear();
	expect(await h.stop("engine_loss")).toEqual({
		result: "stop_failed",
		reason: "stop refused",
	});
	streamSessionProductionDeps.setLifecycleState?.("stop_failed");
	expect(emit.mock.calls).toEqual([
		[
			"stream_stopped",
			{ cause: "engine_loss", durationSec: expect.any(Number) },
		],
		["stream_stop_failed", {}],
	]);
	expect(getStreamLifecycleState()).toBe("stop_failed");
});

test.each([
	{ phase: "applied", outcome: "streaming" },
	{ phase: "reverted", outcome: "streaming" },
	{ phase: "rollback_failed", outcome: "idle" },
	{
		phase: "rollback_failed",
		reason: "engine_connection_lost",
		outcome: "reconciling",
	},
] as const)(
	"reconfiguration $phase / $outcome records the settled lifecycle",
	async ({ phase, outcome, ...rest }) => {
		const h = session({
			changeRuntimeConfig: async () => ({ phase, ...rest }),
		});
		await h.start({ origin: "ui", launch: async () => {} });
		emit.mockClear();
		await h.changeConfig({ resolution: "720p" });
		expect(emit.mock.calls).toEqual([["stream_reconfigured", { outcome }]]);
	},
);

test.each([
	{ result: "recovered" },
	{ result: "failed", reason: "start_failed" },
	{ result: "failed", reason: "runtime_state_unknown" },
	{ result: "adopted" },
	{ result: "blocked" },
] as const)(
	"restoration $result $reason records only terminal attempt outcomes",
	async (scenario) => {
		let marker = JSON.stringify({
			bootId: "same-boot",
			armedAt: 1,
			config: { pipeline: "hdmi" },
		});
		await runStreamRestoration({
			marker: {
				markerPath: "unused",
				readBootId: () => "same-boot",
				readMarker: () => (scenario.result === "blocked" ? undefined : marker),
				writeMarker: (_path, text) => {
					marker = text;
				},
				removeMarker: () => {
					marker = "";
				},
			},
			runtimeState: async () =>
				scenario.result === "adopted"
					? "streaming"
					: "reason" in scenario && scenario.reason === "runtime_state_unknown"
						? "unknown"
						: "idle",
			lifecycleState: () => "idle",
			launch: async () =>
				scenario.result === "failed"
					? { ok: false, reason: "start_failed" }
					: { ok: true },
			awaitRecovery: async () => {},
			now: () => 100,
			unknownDeadlineMs: 0,
			logger: { info: () => {}, warn: () => {} },
		});
		const expected: typeof emit.mock.calls =
			scenario.result === "recovered"
				? [["stream_restored", {}]]
				: scenario.result === "failed"
					? [["stream_restore_failed", { reason: scenario.reason }]]
					: [];
		expect(emit.mock.calls).toEqual(expected);
	},
);

test("engine indicator records only loss and recovery edges while streaming", () => {
	reportEngineState({ isStreaming: true, reachable: false });
	reportEngineState({ isStreaming: true, reachable: false });
	reportEngineState({ isStreaming: true, reachable: true });
	reportEngineState({ isStreaming: true, reachable: true });
	expect(emit.mock.calls).toEqual([
		["engine_lost", { streaming: true }],
		["engine_recovered", { streaming: true }],
	]);
});

test("clearing engine loss after Stop and non-engine indicators record no engine recovery", () => {
	reportEngineState({ isStreaming: true, reachable: false });
	emit.mockClear();
	reportEngineState({ isStreaming: false, reachable: true });
	evaluateIndicator("active-source-lost", true, true);
	evaluateIndicator("active-source-lost", true, false);
	expect(emit.mock.calls).toEqual([]);
});

test("idle reconnect records boot loss once and recovery after a completed heal broadcast", async () => {
	const live = spyOn(streaming, "getIsStreaming").mockReturnValue(false);
	const timers: (() => void)[] = [];
	let reachable = false;
	let broadcasts = 0;
	try {
		await initEngineConnection({
			refreshCapabilities: async () => {},
			isEngineReachable: () => reachable,
			reportEngineState: () => {},
			broadcastEngineState: () => {
				if (++broadcasts === 1) throw new Error("broadcast failed");
			},
			logger: { info: () => {}, warn: () => {} },
			setTimer: (fn) => {
				timers.push(fn);
				const timer = setTimeout(() => {}, 1_000_000);
				clearTimeout(timer);
				return timer;
			},
			clearTimer: clearTimeout,
		});
		timers.shift()?.();
		await settleEngineReconnect();
		reachable = true;
		timers.shift()?.();
		await settleEngineReconnect();
		expect(emit.mock.calls).toEqual([["engine_lost", { streaming: false }]]);
		timers.shift()?.();
		await settleEngineReconnect();
		expect(emit.mock.calls).toEqual([
			["engine_lost", { streaming: false }],
			["engine_recovered", { streaming: false }],
		]);
	} finally {
		live.mockRestore();
	}
});

test.each([true, false])(
	"reachable boot while streaming=%s records no engine loss or recovery",
	async (isStreaming) => {
		const live = spyOn(streaming, "getIsStreaming").mockReturnValue(
			isStreaming,
		);
		try {
			await initEngineConnection({
				refreshCapabilities: async () => {},
				isEngineReachable: () => true,
				reportEngineState: () => {},
				logger: { info: () => {}, warn: () => {} },
			});
			expect(emit.mock.calls).toEqual([]);
		} finally {
			live.mockRestore();
		}
	},
);

test("reconnect leaves live engine loss and recovery reporting to the indicator", async () => {
	const live = spyOn(streaming, "getIsStreaming").mockReturnValue(true);
	const timers: (() => void)[] = [];
	let reachable = false;
	try {
		await initEngineConnection({
			refreshCapabilities: async () => {},
			isEngineReachable: () => reachable,
			reportEngineState: () => {},
			broadcastEngineState: () => {},
			logger: { info: () => {}, warn: () => {} },
			setTimer: (fn) => {
				timers.push(fn);
				const timer = setTimeout(() => {}, 1_000_000);
				clearTimeout(timer);
				return timer;
			},
			clearTimer: clearTimeout,
		});
		reachable = true;
		timers.shift()?.();
		await settleEngineReconnect();
		expect(emit.mock.calls).toEqual([]);
	} finally {
		live.mockRestore();
	}
});

test.each(["links", "config"] as const)(
	"autostart %s refusal records a bounded reason without credentials",
	async (scenario) => {
		const live = spyOn(streaming, "getIsStreaming").mockReturnValue(false);
		const links = spyOn(srtla, "genSrtlaIpList").mockReturnValue(
			scenario === "links" ? [] : ["192.0.2.1"],
		);
		const validate = spyOn(streaming, "validateConfig").mockRejectedValue(
			new Error("secret URL"),
		);
		try {
			await autoStartStream(AUTOSTART_MAX_LINK_ATTEMPTS);
			expect(emit.mock.calls).toEqual([
				[
					"stream_autostart_failed",
					{
						reason:
							scenario === "links"
								? "network_links_unavailable"
								: "start_invalid",
					},
				],
			]);
		} finally {
			live.mockRestore();
			links.mockRestore();
			validate.mockRestore();
		}
	},
);
