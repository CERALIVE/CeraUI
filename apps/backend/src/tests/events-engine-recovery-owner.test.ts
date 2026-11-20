import { afterEach, expect, spyOn, test } from "bun:test";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import * as events from "../modules/events/emit.ts";
import {
	initEngineConnection,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import { resetLifecycleIndicatorState } from "../modules/streaming/lifecycle-indicators.ts";
import * as sources from "../modules/streaming/sources.ts";
import {
	getStreamLifecycleState,
	seedStreamLifecycleState,
} from "../modules/streaming/stream-lifecycle-status.ts";
import * as restoration from "../modules/streaming/stream-restoration.ts";
import * as owner from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import * as hardware from "../modules/system/hardware-kind.ts";

const restores: (() => void)[] = [];
afterEach(() => {
	stopEngineReconnect();
	for (const restore of restores.splice(0).reverse()) restore();
	events.resetEventEmitterForTest();
	resetLifecycleIndicatorState();
	updateStatus(false);
});

function harness(
	initial: boolean,
	runtime: "idle" | "streaming",
	record = false,
) {
	resetLifecycleIndicatorState();
	updateStatus(initial);
	const trace: string[] = [];
	const jobs: (() => void)[] = [];
	const expiry: (() => void)[] = [];
	const stored: DeviceEvent[] = [];
	let reachable = false;
	let now = 0;
	const session = owner.createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		initialLiveness: initial ? "unknown" : "idle",
		queryRuntime: async () => runtime,
		markStreamingForOta: () => true,
		unmarkStreamingForOta: () => true,
		onStreamCommitted: () => {},
		onStreamArmed: () => {},
	});
	events.resetEventEmitterForTest({
		bootId: () => "11111111111111111111111111111111",
		now: () => now,
		tailSeq: () => 0,
		appendEvent: (event) => stored.push(event),
		log: () => {},
		warn: () => {},
		schedule: (fn) => {
			expiry.push(fn);
			return { unref: () => {}, cancel: () => {} };
		},
	});
	const originalEmit = events.emitEvent;
	const emit = spyOn(events, "emitEvent").mockImplementation((code, params) => {
		trace.push(`${code}:${getIsStreaming()}`);
		if (record) originalEmit(code, params);
	});
	const kind = spyOn(hardware, "getHardwareKind").mockResolvedValue("generic");
	const refresh = spyOn(
		sources,
		"refreshAndBroadcastSources",
	).mockResolvedValue(undefined);
	const reconcile = spyOn(owner, "reconcileStreamSession").mockImplementation(
		async () => {
			trace.push(`before:${getIsStreaming()}`);
			const result = await session.reconcile();
			trace.push(`after:${getIsStreaming()}`);
			return result;
		},
	);
	const restoring = spyOn(
		restoration,
		"runStreamRestoration",
	).mockResolvedValue({
		result: "adopted",
	});
	restores.push(
		() => emit.mockRestore(),
		() => kind.mockRestore(),
		() => refresh.mockRestore(),
		() => reconcile.mockRestore(),
		() => restoring.mockRestore(),
	);
	return {
		emit,
		trace,
		jobs,
		stored,
		session,
		refresh,
		kind,
		start: () =>
			initEngineConnection({
				refreshCapabilities: async () => {},
				isEngineReachable: () => reachable,
				logger: { info: () => {}, warn: () => {} },
				setTimer: (fn) => {
					jobs.push(fn);
					const timer = setTimeout(() => {}, 100_000);
					clearTimeout(timer);
					return timer;
				},
				clearTimer: clearTimeout,
			}),
		setReachable: (value: boolean) => {
			reachable = value;
		},
		tick: async () => {
			const job = jobs.shift();
			if (!job) throw new Error("expected a reconnect tick");
			job();
			await settleEngineReconnect();
		},
		expire: () => {
			now = 30_000;
			for (const fn of expiry.splice(0)) fn();
		},
		recoveries: () =>
			emit.mock.calls.filter(([code]) => code === "engine_recovered"),
	};
}

test.each([
	{ initial: false, runtime: "streaming" },
	{ initial: true, runtime: "idle" },
	{ initial: false, runtime: "idle" },
	{ initial: true, runtime: "streaming" },
] as const)(
	"real owner recovery from $initial to $runtime records exactly one pre-reconciliation snapshot",
	async ({ initial, runtime }) => {
		const h = harness(initial, runtime);
		await h.start();
		h.setReachable(true);
		await h.tick();
		expect(h.session.snapshot().state).toBe(runtime);
		expect(h.emit.mock.calls).toEqual([
			["engine_lost", { streaming: initial }],
			["engine_recovered", { streaming: initial }],
		]);
		expect(h.trace).toEqual([
			`engine_lost:${initial}`,
			`before:${initial}`,
			`after:${runtime === "streaming"}`,
			`engine_recovered:${runtime === "streaming"}`,
		]);
	},
);

test.each([false, true])(
	"real owner records no recovery while streaming=%s and refresh remains unreachable",
	async (initial) => {
		const h = harness(initial, "idle");
		await h.start();
		await h.tick();
		expect(h.jobs).toHaveLength(1);
		await h.tick();
		expect(h.recoveries()).toEqual([]);
		expect(h.emit.mock.calls).toEqual([
			["engine_lost", { streaming: initial }],
		]);
	},
);

test("the real owner seeds retained liveness before any engine answer", () => {
	seedStreamLifecycleState("idle");
	const h = harness(true, "streaming");
	expect(getStreamLifecycleState()).toBe("reconciling");
	expect(h.session.snapshot().state).toBe("reconciling");
	expect(h.emit.mock.calls).toEqual([]);
});

test.each([false, true])(
	"failed heal publishes no recovery while streaming=%s; a successful retry publishes once",
	async (initial) => {
		const h = harness(initial, initial ? "idle" : "streaming");
		h.refresh.mockRejectedValueOnce(new Error("source refresh failed"));
		await h.start();
		h.setReachable(true);
		await h.tick();
		expect(h.recoveries()).toEqual([]);
		expect(getIsStreaming()).toBe(initial);
		await h.tick();
		expect(h.recoveries()).toEqual([
			["engine_recovered", { streaming: initial }],
		]);
	},
);

test("completed real-owner heal ignores repeated stale scheduled ticks", async () => {
	const h = harness(false, "streaming");
	await h.start();
	const tick = h.jobs[0];
	h.setReachable(true);
	await h.tick();
	tick?.();
	tick?.();
	await settleEngineReconnect();
	expect(h.recoveries()).toEqual([["engine_recovered", { streaming: false }]]);
});

test.each([false, true])(
	"real emitter retains exactly one folded recovery when the owner changes streaming=%s",
	async (initial) => {
		const h = harness(initial, initial ? "idle" : "streaming", true);
		await h.start();
		h.setReachable(true);
		await h.tick();
		h.expire();
		expect(
			h.stored.map(({ code, params, suppressed }) => ({
				code,
				params,
				suppressed,
			})),
		).toEqual([
			{
				code: "engine_lost",
				params: { streaming: initial },
				suppressed: undefined,
			},
			{
				code: "engine_recovered",
				params: { streaming: initial },
				suppressed: 1,
			},
		]);
	},
);
