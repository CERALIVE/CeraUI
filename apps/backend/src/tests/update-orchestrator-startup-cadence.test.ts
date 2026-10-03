import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	saveOrchestratorState,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	awaitUpdateStartupAdjudication,
	checkUpdatesNow,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("background startup opens readiness when a post-burst CONTROL fault clears", async () => {
	// Given a transient CONTROL fault lasting beyond the six-attempt burst.
	const c = startupCadenceClock();
	let held = true;
	let acquisitions = 0;
	const f = runtimeFixture({
		startupRetryClock: c.clock,
		acquireOsStageControl: async () => {
			acquisitions++;
			if (held) throw new OsStageError("os_update_lock_held");
			return acquireTestOsStageControl();
		},
	});
	fixtures.push(f);
	saveOrchestratorState(initialOrchestratorState(0), f.file);
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	const adjudication = awaitUpdateStartupAdjudication();
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	expect(acquisitions).toBe(6);
	expect(c.delays).toEqual([250, 500, 1000, 2000, 4000]);
	expect(timer.milliseconds).toBe(30_000);
	expect(timer.unreferenced).toBe(true);
	await expect(checkUpdatesNow()).rejects.toHaveProperty(
		"data.retryable",
		true,
	);
	await expect(installUpdatesNow()).rejects.toHaveProperty(
		"data.retryable",
		true,
	);
	expect(() => allowCellularOnce("pending")).toThrow("retry shortly");
	expect(c.timers).toHaveLength(1);
	held = false;
	// When the sole injected background timer fires after the fault clears.
	await timer.work();
	// Then startup adjudicates once and mutation readiness opens without another timer.
	expect(await adjudication).toBe(true);
	expect(acquisitions).toBe(7);
	expect(() => allowCellularOnce("ready")).not.toThrow();
	await startUpdateOrchestrator(f.deps);
	expect(c.timers).toHaveLength(1);
});

test("later retries use one low-frequency attempt rather than restarting the burst", async () => {
	// Given CONTROL still held after the initial burst.
	const c = startupCadenceClock();
	let acquisitions = 0;
	const f = runtimeFixture({
		startupRetryClock: c.clock,
		acquireOsStageControl: async () => {
			acquisitions++;
			throw new OsStageError("os_update_lock_held");
		},
	});
	fixtures.push(f);
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	// When one later timer observes the same fault and another startup caller joins.
	await timer.work();
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	// Then only one later attempt ran and exactly one replacement timer is armed.
	expect(acquisitions).toBe(7);
	expect(c.delays).toHaveLength(5);
	expect(c.timers.map((t) => t.milliseconds)).toEqual([30_000, 30_000]);
	expect(c.timers.every((t) => t.unreferenced)).toBe(true);
});

test("authoritative startup safety refusal never enters either retry cadence", async () => {
	// Given an authoritative private ownership refusal without an I/O cause.
	const c = startupCadenceClock();
	let acquisitions = 0;
	const f = runtimeFixture({
		startupRetryClock: c.clock,
		acquireOsStageControl: async () => {
			acquisitions++;
			throw new OsStageError("rauc_recovery_unproven");
		},
	});
	fixtures.push(f);
	// When startup refuses and another caller asks to start again.
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	// Then refusal adjudicates closed with no timer or state repair.
	expect(acquisitions).toBe(1);
	expect(c.delays).toEqual([]);
	expect(c.timers).toEqual([]);
	expect(await awaitUpdateStartupAdjudication()).toBe(false);
	expect(() => allowCellularOnce("unsafe")).toThrow("retry shortly");
});

test("invalid present recovery metadata settles maintenance-blocked without retry or clearance", async () => {
	// Given invalid metadata on a plan-bearing persisted commit.
	const c = startupCadenceClock();
	const f = runtimeFixture({ startupRetryClock: c.clock });
	fixtures.push(f);
	const bytes = JSON.stringify({
		...toPersisted(identifiedState()),
		phase: "committing",
		osStageRecovery: { invalid: true },
	});
	await Bun.write(f.file, bytes);
	// When the loader returns its maintenance-blocked terminal verdict.
	await startUpdateOrchestrator(f.deps);
	// Then no standalone cleanup permission or startup retries follow.
	expect(await awaitUpdateStartupAdjudication()).toBe(false);
	expect(c.delays).toEqual([]);
	expect(c.timers).toEqual([]);
	expect(await Bun.file(f.file).text()).toBe(bytes);
	expect(() => allowCellularOnce("invalid")).toThrow("retry shortly");
});

test("runtime teardown cancels an unreferenced background retry", async () => {
	// Given a background startup retry parked after transient exhaustion.
	const c = startupCadenceClock();
	const f = runtimeFixture({
		startupRetryClock: c.clock,
		acquireOsStageControl: async () => {
			throw new OsStageError("os_update_lock_held");
		},
	});
	fixtures.push(f);
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	const timer = c.timers[0];
	if (!timer) throw new Error("background retry was not armed");
	// When fixture teardown retires this startup owner.
	resetOrchestratorRuntimeForTest();
	// Then its timer cannot run later in another fixture's lifetime.
	expect(timer.cancelled).toBe(true);
	await timer.work();
	expect(c.timers).toHaveLength(1);
});
