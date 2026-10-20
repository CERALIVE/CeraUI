import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	admitAndPrepareStreamStart,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { reconcileStaleUnits } from "../modules/system/update-orchestrator/stale-services.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";
import { receipt, setup } from "./helpers/os-agent-runtime-harness.ts";

let dir = "";
const marker = process.env.CERALIVE_STREAMING_MARKER;
const nodeEnv = process.env.NODE_ENV;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "power-update-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	process.env.NODE_ENV = "production";
	updateStatus(false);
	updateStreamLifecycleState("idle");
	resetOrchestratorRuntimeForTest();
});
afterEach(() => {
	resetPowerCommandRunner();
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	if (marker === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = marker;
	if (nodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = nodeEnv;
	rmSync(dir, { recursive: true, force: true });
});

test("timed OS arming excludes starts through successful reboot submission", async () => {
	// Given a due activation with its external arm command held at submission.
	const entered = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	setup({
		now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
		armOs: () => {
			entered.resolve();
			return finished.promise;
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-activation-armed",
	});
	const tick = runOrchestratorTick();
	await entered.promise;
	// When a start arrives while arming and again after successful submission.
	const during = await admitAndPrepareStreamStart();
	finished.resolve();
	await tick;
	const after = await admitAndPrepareStreamStart();
	// Then both orders refuse; command completion cannot end pending shutdown.
	expect(during).toEqual({
		allowed: false,
		reason: "update_in_progress",
		phase: "committing",
		percent: 0,
		etaSeconds: 0,
	});
	expect(after).toEqual({
		allowed: false,
		reason: "update_in_progress",
		phase: "committing",
		percent: 0,
		etaSeconds: 0,
	});
});

test("timed activation rechecks the final clock after asynchronous preparation", async () => {
	// Given a due age snapshot whose clock rolls back before final dispatch.
	let observingActivation = false;
	let ageReads = 0;
	const due = receipt.stagedAt + 7 * 24 * 60 * 60_000;
	const armed: boolean[] = [];
	setup({
		readBootId: async () => {
			observingActivation = true;
			return receipt.bootId;
		},
		now: () => (observingActivation && ageReads++ > 0 ? due - 1 : due),
		armOs: async (now) => {
			armed.push(now);
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-activation-armed",
	});
	// When the actual timed activation boundary evaluates its final predicates.
	await runOrchestratorTick();
	// Then stale elapsed-time permission does not submit an early reboot.
	expect(armed).toEqual([]);
});

test("stale restart refuses a stream queued inside its final idle await", async () => {
	// Given an eligible stale unit and a snapshot idle predicate.
	const restarted: string[] = [];
	// When a stream wins the idle await before restart submission.
	const result = await reconcileStaleUnits({
		units: ["example.service"],
		isIdle: async () => {
			queueMicrotask(() => updateStatus(true));
			return true;
		},
		transactionRunning: () => false,
		restart: async (unit) => {
			restarted.push(unit);
		},
		recommend: () => {},
	});
	// Then the current shared gate withholds the effect.
	expect(restarted).toEqual([]);
	expect(result).toBe(false);
});

test("stale restart holds reciprocal exclusion until the restart completes", async () => {
	// Given a blocking restart whose completion is externally controlled.
	const entered = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const restart = reconcileStaleUnits({
		units: ["example.service"],
		isIdle: async () => true,
		transactionRunning: () => false,
		restart: () => {
			entered.resolve();
			return finished.promise;
		},
		recommend: () => {},
	});
	await entered.promise;
	// When start is attempted during that effect.
	const result = await admitAndPrepareStreamStart();
	finished.resolve();
	await restart;
	// Then the active lifetime refused start, and positive completion reopens it.
	expect(result).toEqual({
		allowed: false,
		reason: "update_in_progress",
		phase: "committing",
		percent: 0,
		etaSeconds: 0,
	});
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
});

test("pending power refuses a subsequent package install", async () => {
	// Given a reconciled runtime and accepted power while no install is running.
	setup({ startPackageInstall: () => ({ started: true }) });
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "available",
	});
	setPowerCommandRunner(() => {});
	await call(rebootProcedure, undefined, { context: buildControlContext() });
	// When the real manual install admission runs during pending shutdown.
	const result = await installUpdatesNow();
	// Then the existing busy reason refuses rather than starting work.
	expect(result).toEqual({ started: false, reason: "busy" });
});
