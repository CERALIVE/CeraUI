import { afterEach, expect, test } from "bun:test";
import { OsAgentError } from "../modules/system/update-orchestrator/os-agent.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { loadOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";
import { lifecycleFixture } from "./helpers/os-attempt-lifecycle-fixture.ts";

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const [reason, mode] of [
	["os_transport_failed", "automatic"],
	["os_origin_unavailable", "automatic"],
	["rauc_install_failed", "operator"],
	["os_cellular_approval_required", "operator"],
	["rauc_recovery_unproven", "unsafe"],
	["os_stage_outcome_unknown_after_restart", "unsafe"],
] as const) {
	test(`launched ${reason} settlement retires intent and survives a fresh runtime`, async () => {
		// Given an actual runtime launch with a private on-disk job and intent.
		const f = lifecycleFixture();
		fixtures.push(f);
		await f.offer({
			stageOs: async () => {
				throw new OsStageError(reason);
			},
		});
		// When the producer settles with its typed policy.
		expect((await installUpdatesNow()).started).toBe(false);
		// Then the intent is gone before restart, and the original round remains exact.
		expect(f.effects.stages).toBe(1);
		expect(f.intentStore.read()).toBeNull();
		const settled = getOrchestratorState();
		expect(settled.osStageRecovery).toMatchObject({
			activeAttemptId: null,
			failedRounds: 1,
			mode,
			reason,
		});
		await f.restart();
		expect(await loadOrchestratorState(f.file)).toEqual(settled);
		expect(f.intentStore.read()).toBeNull();
	});
}

test("late unsafe release failure retains receipt and retires the launched intent across restart", async () => {
	// Given receipt publication before an unsafe producer release outcome.
	const f = lifecycleFixture();
	fixtures.push(f);
	await f.offer({
		stageOs: async (candidate, progress, control) => {
			await f.deps.stageOs(candidate, progress, control);
			throw new OsStageError("rauc_recovery_unproven");
		},
	});
	// When producer release fails after the commit callback.
	expect((await installUpdatesNow()).started).toBe(false);
	// Then receipt evidence survives, but no old launching intent blocks startup.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
		osStageRecovery: { failedRounds: 1, mode: "unsafe" },
	});
	expect(await f.deps.readOsReceipt()).toBeDefined();
	expect(f.intentStore.read()).toBeNull();
	await f.restart();
	expect(getOrchestratorState().failureReason).toBe("rauc_recovery_unproven");
	expect(f.intentStore.read()).toBeNull();
});

test("launched cancellation ends intent lifetime without spending a failed round", async () => {
	// Given a launched producer reporting cancellation after entering the job.
	const f = lifecycleFixture();
	fixtures.push(f);
	await f.offer({
		stageOs: async () => {
			throw new OsStageError("os_stage_cancelled_for_stream");
		},
	});
	// When the cancellation settles.
	expect((await installUpdatesNow()).started).toBe(false);
	// Then cancellation is not converted into unknown restart policy.
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		failureReason: null,
		osStageRecovery: { activeAttemptId: null, failedRounds: 0 },
	});
	expect(f.intentStore.read()).toBeNull();
	await f.restart();
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(0);
});

test("D8 abort mid-stage retires intent after producer settlement and remains zero-round after restart", async () => {
	// Given a launched job held at the producer boundary.
	const f = lifecycleFixture();
	fixtures.push(f);
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	await f.offer({
		stageOs: async (_candidate, _progress, control) => {
			if (!control?.signal) throw new Error("stage signal missing");
			control.signal.addEventListener("abort", () => finish.resolve(), {
				once: true,
			});
			entered.resolve();
			await finish.promise;
			throw new OsStageError("os_stage_cancelled_for_stream");
		},
	});
	const install = installUpdatesNow();
	await entered.promise;
	// When the real D8 admission aborts that producer.
	expect(await admitAndPrepareStreamStart()).toMatchObject({ allowed: true });
	await install;
	// Then the finally ends the intent lifetime without inventing failure policy.
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(0);
	expect(f.intentStore.read()).toBeNull();
	await f.restart();
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		failureReason: null,
		osStageRecovery: { activeAttemptId: null, failedRounds: 0 },
	});
});

for (const fault of [
	new Error("untyped producer failure"),
	new OsAgentError("expired"),
]) {
	test(`stage invocation ${fault.message} ends launching intent despite record removal or generic failure`, async () => {
		// Given producer invocation with an outcome outside typed stage recovery.
		const f = lifecycleFixture();
		fixtures.push(f);
		await f.offer({
			stageOs: async () => {
				throw fault;
			},
		});
		// When its terminal or offer-invalidation path completes.
		expect((await installUpdatesNow()).started).toBe(false);
		// Then intent cleanup does not depend on a surviving recovery record.
		expect(f.intentStore.read()).toBeNull();
		const phase = getOrchestratorState().phase;
		await f.restart();
		expect(getOrchestratorState().phase).toBe(phase);
	});
}
