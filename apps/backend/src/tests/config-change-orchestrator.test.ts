import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { CerastreamRpcError } from "@ceralive/cerastream";
import {
	CHANGE_CONFIG_WORST_CASE_BOUND_MS,
	CONFIG_CHANGE_REASON_DEADLINE,
	CONFIG_CHANGE_REASON_REJECTED,
	CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
	type LifecycleState,
	type StopResult,
} from "@ceraui/rpc/schemas";

import { logger } from "../helpers/logger.ts";
import {
	RECONFIGURE_DEADLINE_MS,
	STOP_DEADLINE_MS,
} from "../modules/streaming/start-lifecycle-timing.ts";
import {
	type ConfigChangePhaseEvent,
	createStreamSessionOrchestrator,
	type EngineConfigChangeOutcome,
	RECONFIGURE_STOP_TIMEOUT_REASON,
	type StreamSessionOrchestrator,
} from "../modules/streaming/stream-session-orchestrator.ts";

type FakeTimer = {
	readonly id: number;
	readonly delayMs: number;
	readonly callback: () => void;
	fired: boolean;
	cancelled: boolean;
};

class FakeClock {
	private nextId = 1;
	readonly timers: FakeTimer[] = [];

	schedule = (callback: () => void, delayMs: number): number => {
		const timer: FakeTimer = {
			id: this.nextId++,
			delayMs,
			callback,
			fired: false,
			cancelled: false,
		};
		this.timers.push(timer);
		return timer.id;
	};

	cancel = (id: number | ReturnType<typeof setTimeout>): void => {
		const timer = this.timers.find((candidate) => candidate.id === id);
		if (timer) timer.cancelled = true;
	};

	pending(delayMs: number): FakeTimer[] {
		return this.timers.filter(
			(timer) => timer.delayMs === delayMs && !timer.fired && !timer.cancelled,
		);
	}

	fire(delayMs: number): number {
		const due = this.pending(delayMs);
		for (const timer of due) {
			timer.fired = true;
			timer.callback();
		}
		return due.length;
	}
}

async function settleMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

type Harness = {
	readonly orchestrator: StreamSessionOrchestrator;
	readonly clock: FakeClock;
	readonly phases: ConfigChangePhaseEvent[];
	readonly lifecycle: LifecycleState[];
	readonly stopCalls: number[];
	readonly streamingStatus: boolean[];
	settleChange: (outcome: EngineConfigChangeOutcome) => void;
	rejectChange: (error: unknown) => void;
	readonly changeCalls: string[];
	runtimeState: "idle" | "streaming" | "unknown";
	stopRuntimeSettles: boolean;
};

function harness(): Harness {
	const clock = new FakeClock();
	const phases: ConfigChangePhaseEvent[] = [];
	const lifecycle: LifecycleState[] = [];
	const stopCalls: number[] = [];
	const streamingStatus: boolean[] = [];
	const changeCalls: string[] = [];
	let attempts = 0;

	const state: Harness = {
		clock,
		phases,
		lifecycle,
		stopCalls,
		streamingStatus,
		changeCalls,
		runtimeState: "idle",
		stopRuntimeSettles: true,
		settleChange: () => {},
		rejectChange: () => {},
		orchestrator: undefined as unknown as StreamSessionOrchestrator,
	};

	state.orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => `attempt-${++attempts}`,
		setStreamingStatus: (streaming) => streamingStatus.push(streaming),
		stopRuntime: async (generation) => {
			stopCalls.push(generation);
			if (!state.stopRuntimeSettles) await new Promise<void>(() => {});
		},
		queryRuntime: async () => state.runtimeState,
		setLifecycleState: (next) => lifecycle.push(next),
		scheduleTimeout: clock.schedule,
		cancelTimeout: clock.cancel,
		scheduleLaunchDeadline: clock.schedule,
		cancelLaunchDeadline: clock.cancel,
		publishConfigChangePhase: (event) => phases.push(event),
		changeRuntimeConfig: async (_delta, attemptId) => {
			changeCalls.push(attemptId);
			return new Promise<EngineConfigChangeOutcome>((resolve, reject) => {
				state.settleChange = resolve;
				state.rejectChange = reject;
			});
		},
	});

	return state;
}

async function bringToStreaming(h: Harness): Promise<void> {
	const started = await h.orchestrator.start({
		origin: "ui",
		launch: async () => {},
	});
	expect(started.result).toBe("started");
	expect(h.orchestrator.snapshot().state).toBe("streaming");
	h.lifecycle.length = 0;
	h.streamingStatus.length = 0;
}

function changeAttemptId(h: Harness): string {
	const applying = h.phases.find((phase) => phase.phase === "applying");
	expect(applying).toBeDefined();
	return applying?.attemptId ?? "";
}

describe("apply-now config change — admission", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	test("refuses a change while idle — a transaction needs a live session", async () => {
		// Given an idle orchestrator.
		// When an apply-now change is requested.
		const result = await h.orchestrator.changeConfig({
			resolution: "3840x2160",
		});

		// Then it is refused without touching the engine.
		expect(result).toEqual({ result: "busy" });
		expect(h.changeCalls).toEqual([]);
		expect(h.phases).toEqual([]);
	});

	test("refuses a SECOND change while one is in flight", async () => {
		// Given a live stream with a change already applying.
		await bringToStreaming(h);
		const first = h.orchestrator.changeConfig({ framerate: 30 });
		await settleMicrotasks();

		// When a second change is requested.
		const second = await h.orchestrator.changeConfig({ framerate: 60 });

		// Then it is refused; only ONE transaction ever reached the engine.
		expect(second).toEqual({ result: "busy" });
		expect(h.changeCalls).toHaveLength(1);

		h.settleChange({ phase: "applied" });
		await first;
	});

	test("refuses a start while reconfiguring", async () => {
		// Given a live stream mid-change.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ framerate: 30 });
		await settleMicrotasks();

		// When a start is requested.
		const started = await h.orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});

		// Then the lifecycle slot is busy.
		expect(started.result).toBe("busy");

		h.settleChange({ phase: "applied" });
		await change;
	});
});

describe("apply-now config change — typed outcomes", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	test("applied returns the stream to streaming and publishes applying then applied", async () => {
		// Given a live stream.
		await bringToStreaming(h);

		// When the transaction applies.
		const pending = h.orchestrator.changeConfig({ resolution: "3840x2160" });
		await settleMicrotasks();
		expect(h.orchestrator.snapshot().state).toBe("reconfiguring");
		const attemptId = changeAttemptId(h);
		expect(h.phases).toEqual([{ attemptId, phase: "applying" }]);

		h.settleChange({ phase: "applied" });
		const result = await pending;

		// Then the stream is live again and both phases were published in order.
		expect(result).toEqual({ result: "applied", attemptId });
		expect(h.orchestrator.snapshot().state).toBe("streaming");
		expect(h.phases.map((phase) => phase.phase)).toEqual([
			"applying",
			"applied",
		]);
	});

	test("reverted keeps the stream live and carries the engine reason", async () => {
		// Given a live stream.
		await bringToStreaming(h);
		const pending = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();
		const attemptId = changeAttemptId(h);

		// When the engine reverts to the known-good config.
		h.settleChange({ phase: "reverted", reason: "not_negotiated" });
		const result = await pending;

		// Then the stream survives and the honest reason reaches the UI.
		expect(result).toEqual({
			result: "reverted",
			attemptId,
			reason: "not_negotiated",
		});
		expect(h.orchestrator.snapshot().state).toBe("streaming");
		expect(h.phases.at(-1)).toEqual({
			attemptId,
			phase: "reverted",
			reason: "not_negotiated",
		});
	});

	test("rollback_failed leaves reconfiguring for idle — never a stuck applying", async () => {
		// Given a live stream.
		await bringToStreaming(h);
		const pending = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();
		const attemptId = changeAttemptId(h);

		// When the engine cannot restore the known-good config and goes Idle.
		h.settleChange({
			phase: "rollback_failed",
			reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
		});
		const result = await pending;

		// Then the orchestrator adopts idle and reports the typed reason.
		expect(result).toEqual({
			result: "rollback_failed",
			attemptId,
			reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
		});
		expect(h.orchestrator.snapshot().state).toBe("idle");
		expect(h.streamingStatus).toContain(false);
	});

	test("a phase from a SUPERSEDED attempt cannot settle the current transaction", async () => {
		// Given a live stream with attempt-1 in flight.
		await bringToStreaming(h);
		const pending = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();

		// When a stale phase from an older attempt arrives on the bus.
		h.orchestrator.noteConfigChangePhase({
			attemptId: `${changeAttemptId(h)}-stale`,
			phase: "applied",
		});
		await settleMicrotasks();

		// Then nothing settles — the state and published phases are untouched.
		expect(h.orchestrator.snapshot().state).toBe("reconfiguring");
		expect(h.phases.map((phase) => phase.phase)).toEqual(["applying"]);

		h.settleChange({ phase: "applied" });
		await pending;
	});
});

describe("stop during a config-change transaction", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	test("stop-during-applying QUEUES — the 12 s stop deadline never fires stop_failed", async () => {
		// Given a live stream with a change applying.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ resolution: "3840x2160" });
		await settleMicrotasks();

		// When a stop is requested mid-transaction.
		let stopSettled = false;
		const stop = h.orchestrator.stop().then((result) => {
			stopSettled = true;
			return result;
		});
		await settleMicrotasks();

		// Then no stop deadline was even armed, and the stop has NOT resolved.
		expect(h.clock.pending(STOP_DEADLINE_MS)).toHaveLength(0);
		expect(stopSettled).toBe(false);
		expect(h.orchestrator.snapshot().state).toBe("reconfiguring");
		expect(h.stopCalls).toEqual([]);

		// And when the transaction finally applies, the queued stop runs honestly.
		h.settleChange({ phase: "applied" });
		await change;
		await settleMicrotasks();
		expect(await stop).toEqual({ result: "stopped" });
		expect(h.orchestrator.snapshot().state).toBe("idle");
	});

	test("stop-during-ROLLBACK still resolves honestly at the worst-case deadline", async () => {
		// Given a live stream whose change is rolling back for the full bound.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();
		const stop = h.orchestrator.stop();
		await settleMicrotasks();

		// When the engine's rollback also fails, right at the declared bound.
		h.settleChange({
			phase: "rollback_failed",
			reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
		});
		const changeResult = await change;
		await settleMicrotasks();

		// Then the change reports the typed failure AND the queued stop resolves
		// against the state the transaction actually left behind — idle.
		expect(changeResult.result).toBe("rollback_failed");
		expect(await stop).toEqual({ result: "stopped" });
		expect(h.orchestrator.snapshot().state).toBe("idle");
	});

	test("two stops during one transaction share a single queued resolution", async () => {
		// Given a live stream mid-change with two stop requests.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ framerate: 30 });
		await settleMicrotasks();
		const first = h.orchestrator.stop();
		const second = h.orchestrator.stop();
		await settleMicrotasks();

		// When the transaction applies.
		h.settleChange({ phase: "applied" });
		await change;
		await settleMicrotasks();

		// Then both callers get the same honest answer and the runtime stopped once.
		expect(await first).toEqual({ result: "stopped" });
		expect(await second).toEqual({ result: "stopped" });
		expect(h.stopCalls).toHaveLength(1);
	});
});

describe("a parked stop is bounded and announced", () => {
	let h: Harness;
	let warns: Array<[string, unknown]>;
	let errors: Array<[string, unknown]>;

	beforeEach(() => {
		h = harness();
		warns = [];
		errors = [];
		spyOn(logger, "warn").mockImplementation((message, meta) => {
			warns.push([String(message), meta]);
			return logger;
		});
		spyOn(logger, "error").mockImplementation((message, meta) => {
			errors.push([String(message), meta]);
			return logger;
		});
	});

	afterEach(() => {
		mock.restore();
	});

	test("a transaction that never settles no longer strands the stop forever", async () => {
		// Given a live stream, a change in flight, and an operator stop parked
		// behind it.
		await bringToStreaming(h);
		void h.orchestrator.changeConfig({ resolution: "3840x2160" });
		await settleMicrotasks();
		let settled: StopResult | undefined;
		const stop = h.orchestrator.stop().then((result) => {
			settled = result;
			return result;
		});
		await settleMicrotasks();
		expect(settled).toBeUndefined();

		// When the transaction breaks every bound it declared and never settles.
		expect(
			h.clock.fire(RECONFIGURE_DEADLINE_MS + STOP_DEADLINE_MS),
		).toBeGreaterThan(0);
		await settleMicrotasks();

		// Then the operator gets a truthful answer instead of silence, and the
		// orchestrator asks the engine what is actually true rather than
		// asserting a state of its own.
		expect(await stop).toEqual({
			result: "stop_failed",
			reason: RECONFIGURE_STOP_TIMEOUT_REASON,
		});
		expect(h.lifecycle).toContain("reconciling");
	});

	test("parking a stop is written to the log — the pre-fix path said nothing at all", async () => {
		// Given a live stream mid-change.
		await bringToStreaming(h);
		void h.orchestrator.changeConfig({ framerate: 30 });
		await settleMicrotasks();

		// When a stop is parked behind the transaction.
		void h.orchestrator.stop();
		await settleMicrotasks();

		// Then the wait is named, with the budget it is allowed.
		const parked = warns.find(([message]) =>
			message.includes("parked behind an in-flight config change"),
		);
		expect(parked).toBeDefined();
		expect(parked?.[1]).toMatchObject({
			budgetMs: RECONFIGURE_DEADLINE_MS + STOP_DEADLINE_MS,
		});
	});

	test("a released stop disarms its deadline so a late tick cannot overwrite the answer", async () => {
		// Given a stop parked behind a change that then applies.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ framerate: 30 });
		await settleMicrotasks();
		const stop = h.orchestrator.stop();
		await settleMicrotasks();
		h.settleChange({ phase: "applied" });
		await change;
		await settleMicrotasks();
		expect(await stop).toEqual({ result: "stopped" });

		// When the parked stop's deadline would have fired.
		expect(h.clock.fire(RECONFIGURE_DEADLINE_MS + STOP_DEADLINE_MS)).toBe(0);
		await settleMicrotasks();

		// Then nothing was reported and the honest answer stands.
		expect(h.orchestrator.snapshot().state).toBe("idle");
		expect(
			errors.filter(([message]) => message.includes("parked behind")),
		).toEqual([]);
	});

	test("a stop that misses its own deadline is logged — it used to fail in silence", async () => {
		// Given a live stream whose runtime stop never completes.
		const stuck = harness();
		stuck.stopRuntimeSettles = false;
		await bringToStreaming(stuck);
		const stop = stuck.orchestrator.stop();
		await settleMicrotasks();

		// When the stop deadline expires.
		expect(stuck.clock.fire(STOP_DEADLINE_MS)).toBeGreaterThan(0);
		await settleMicrotasks();

		// Then the failure is both returned AND recorded.
		expect((await stop).result).toBe("stop_failed");
		expect(
			errors.some(([message]) =>
				message.includes("stream stop did not settle within its deadline"),
			),
		).toBe(true);
	});
});

describe("engine escalation during reconfiguring", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	test("rollback_failed{teardown_timeout} then engine EXIT: leaves reconfiguring, queued stop resolves, reason survives", async () => {
		// Given a live stream, a change in flight, and an operator stop queued behind it.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ resolution: "3840x2160" });
		await settleMicrotasks();
		const stop = h.orchestrator.stop();
		await settleMicrotasks();
		expect(h.orchestrator.snapshot().state).toBe("reconfiguring");
		const attemptId = changeAttemptId(h);

		// When the engine publishes the supervisor escalation on the BUS and THEN
		// exits, so the in-flight RPC rejects on a dead control socket.
		h.orchestrator.noteConfigChangePhase({
			attemptId,
			phase: "rollback_failed",
			reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
		});
		h.rejectChange(new Error("control connection is not open"));
		const result = await change;
		await settleMicrotasks();

		// Then the bus reason wins over the dead-socket rejection...
		expect(result).toEqual({
			result: "rollback_failed",
			attemptId,
			reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
		});
		// ...the orchestrator LEFT reconfiguring...
		expect(h.orchestrator.snapshot().state).toBe("idle");
		// ...the UI never sees a terminal phase other than the honest one...
		expect(h.phases).toEqual([
			{ attemptId, phase: "applying" },
			{
				attemptId,
				phase: "rollback_failed",
				reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
			},
		]);
		// ...and the queued stop resolves honestly rather than hanging.
		expect(await stop).toEqual({ result: "stopped" });
	});

	test("a bare engine exit with NO bus phase still leaves reconfiguring", async () => {
		// Given a live stream mid-change.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();

		// When the control connection dies with no phase published at all.
		h.rejectChange(new Error("control connection is not open"));
		const result = await change;

		// Then the transaction still terminates rather than stranding the UI.
		expect(result.result).toBe("rollback_failed");
		expect(h.orchestrator.snapshot().state).toBe("idle");
		expect(h.phases.at(-1)?.phase).toBe("rollback_failed");
	});

	test("a REFUSED transaction reverts and keeps streaming — it is not a failed rollback", async () => {
		// Given a live stream and an engine that refuses the parameters outright.
		// The board produced exactly this while mpp kept encoding without a
		// dropped frame, and it was reported as
		// `rollback_failed{engine_connection_lost}` — a claim the operator's
		// broadcast may be dead, made about a healthy stream.
		await bringToStreaming(h);
		const change = h.orchestrator.changeConfig({ resolution: "720p" });
		await settleMicrotasks();
		const attemptId = changeAttemptId(h);

		// When the engine answers with a structured JSON-RPC error, which by its
		// own contract means the transaction never began.
		h.rejectChange(
			new CerastreamRpcError(
				"invalid params: unsupported resolution '720p'",
				-32602,
			),
		);
		const result = await change;
		await settleMicrotasks();

		// Then the operator is told the change did not take...
		expect(result).toEqual({
			result: "reverted",
			attemptId,
			reason: CONFIG_CHANGE_REASON_REJECTED,
		});
		// ...the stream is still live, never torn down...
		expect(h.orchestrator.snapshot().state).toBe("streaming");
		expect(h.stopCalls).toHaveLength(0);
		// ...and the UI sees exactly the honest phase pair.
		expect(h.phases).toEqual([
			{ attemptId, phase: "applying" },
			{ attemptId, phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED },
		]);
	});

	test("a transaction that outlives the declared bound reconciles against engine truth", async () => {
		// Given a live stream mid-change and an engine that still reports streaming.
		await bringToStreaming(h);
		h.runtimeState = "streaming";
		const change = h.orchestrator.changeConfig({ framerate: 60 });
		await settleMicrotasks();
		const attemptId = changeAttemptId(h);

		// When the reconfigure deadline expires with no engine answer at all.
		expect(h.clock.pending(RECONFIGURE_DEADLINE_MS)).toHaveLength(1);
		h.clock.fire(RECONFIGURE_DEADLINE_MS);
		const result = await change;
		await settleMicrotasks();

		// Then it terminates as a typed deadline failure and adopts the engine's truth.
		expect(result).toEqual({
			result: "rollback_failed",
			attemptId,
			reason: CONFIG_CHANGE_REASON_DEADLINE,
		});
		expect(h.orchestrator.snapshot().state).toBe("streaming");
	});
});

describe("reconfigure deadline sizing", () => {
	test("is the engine's declared bound plus one stop bound, never the stop bound alone", () => {
		expect(RECONFIGURE_DEADLINE_MS).toBe(
			CHANGE_CONFIG_WORST_CASE_BOUND_MS + STOP_DEADLINE_MS,
		);
		expect(RECONFIGURE_DEADLINE_MS).toBe(77_000);
		expect(RECONFIGURE_DEADLINE_MS).toBeGreaterThan(STOP_DEADLINE_MS);
	});
});
