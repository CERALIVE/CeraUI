import { afterEach, expect, test } from "bun:test";
import { call } from "@orpc/server";
import {
	saveOrchestratorState,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	getOrchestratorWireState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	allowCellularOnceProcedure,
	checkUpdatesNowProcedure,
	installUpdatesNowProcedure,
} from "../rpc/procedures/system.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("update mutations refuse while startup awaits recovery and the same cellular RPC works afterwards", async () => {
	// Given a persisted unsafe record and startup paused at its recovery evidence.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	const f = runtimeFixture({
		proveOsWriterQuiescent: () => {
			entered.resolve();
			return release.promise;
		},
	});
	fixtures.push(f);
	saveOrchestratorState(identifiedState(), f.file);
	f.writeWitness();
	const before = await Bun.file(f.file).text();
	const startup = startUpdateOrchestrator(f.deps);
	await entered.promise;
	const context = makeRpcContext();
	try {
		// When authenticated mutation RPCs or direct runtime callers arrive early.
		for (const mutation of [
			() => call(allowCellularOnceProcedure, { id: "grant" }, { context }),
			() => call(checkUpdatesNowProcedure, undefined, { context }),
			() => call(installUpdatesNowProcedure, undefined, { context }),
			async () => allowCellularOnce("grant"),
			() => checkUpdatesNow(),
			() => installUpdatesNow(),
		]) {
			const result = mutation();
			await expect(result).rejects.toHaveProperty(
				"code",
				"UPDATE_ORCHESTRATOR_INITIALIZING",
			);
			await expect(result).rejects.toHaveProperty("data.retryable", true);
		}
		// Then the unsafe bytes survive, and reads/stream admission are not gated.
		expect(await Bun.file(f.file).text()).toBe(before);
		expect(getOrchestratorWireState().phase).toBe("failed");
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	} finally {
		release.resolve(true);
		await startup;
	}
	expect(
		await call(allowCellularOnceProcedure, { id: "grant" }, { context }),
	).toEqual({ success: true });
	expect(getOrchestratorState().cellularOverrideId).toBe("grant");
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

test("an invalid present terminal record stays mutation-closed after the load verdict", async () => {
	// Given invalid OS metadata on a terminal package/X6 record.
	const f = runtimeFixture();
	fixtures.push(f);
	const terminal = {
		...toPersisted(identifiedState()),
		failureReason: "commit_unit_absent_on_resume",
		osStageRecovery: { invalid: true },
	};
	await Bun.write(f.file, JSON.stringify(terminal));
	const before = await Bun.file(f.file).text();
	// When startup completes its invalid-load branch and an authenticated grant arrives.
	await startUpdateOrchestrator(f.deps);
	await expect(
		call(
			allowCellularOnceProcedure,
			{ id: "grant" },
			{ context: makeRpcContext() },
		),
	).rejects.toHaveProperty("code", "UPDATE_ORCHESTRATOR_INITIALIZING");
	// Then H2-R2 retains the exact terminal file; no idle grant can replace it.
	expect(await Bun.file(f.file).text()).toBe(before);
	expect(getOrchestratorState().failureReason).toBe(
		"commit_unit_absent_on_resume",
	);
});

test("module-initialized idle cannot accept a grant before startup is invoked", () => {
	const f = runtimeFixture();
	fixtures.push(f);
	resetOrchestratorRuntimeForTest();
	expect(() => allowCellularOnce("grant")).toThrow("retry shortly");
});
