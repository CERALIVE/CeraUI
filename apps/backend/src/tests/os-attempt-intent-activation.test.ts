import { afterEach, expect, test } from "bun:test";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { loadOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	type OrchestratorRuntimeDeps,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { lifecycleFixture } from "./helpers/os-attempt-lifecycle-fixture.ts";
import { manifest } from "./helpers/os-stage-unlaunched-fixture.ts";

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("receipt publication retains launching intent until producer release, then restart is unwedged", async () => {
	// Given receipt publication with a still-held producer job.
	const f = lifecycleFixture();
	fixtures.push(f);
	const published = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await f.offer({
		stageOs: async (candidate, progress, control) => {
			await f.deps.stageOs(candidate, progress, control);
			published.resolve();
			await release.promise;
		},
	});
	const install = installUpdatesNow();
	await published.promise;
	expect(getOrchestratorState().phase).toBe("os-staged");
	expect(f.intentStore.read()?.phase).toBe("launching");
	expect((await f.deps.readOsStageJob?.())?.launched).toBe(true);
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(0);
	// When the producer release completes.
	release.resolve();
	expect((await install).started).toBe(true);
	// Then receipt survives but job, intent and active identity do not.
	expect(await f.deps.readOsReceipt()).toMatchObject({
		version: manifest.version,
	});
	expect(await f.deps.readOsStageJob?.()).toBeNull();
	expect(f.intentStore.read()).toBeNull();
	expect(getOrchestratorState().osStageRecovery).toBeUndefined();
	await f.restart();
	expect(getOrchestratorState().phase).toBe("os-staged");
});

test("success advances through armed reboot and this-boot verification with no stale intent", async () => {
	// Given a normally settled launch and a durable receipt.
	const f = lifecycleFixture();
	fixtures.push(f);
	const phases: OrchestratorState["phase"][] = [];
	const observe: Pick<OrchestratorRuntimeDeps, "publishWireState"> = {
		publishWireState: (wire) => {
			phases.push(wire.phase);
		},
	};
	await f.offer(observe);
	expect((await installUpdatesNow()).started).toBe(true);
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("os-activation-armed");
	f.effects.bootId = "00000000-0000-4000-8000-000000000008";
	f.effects.bootedVersion = manifest.version;
	f.effects.healthy = false;
	// When a new runtime observes reboot, then this boot's health verdict arrives.
	await f.restart(observe);
	expect(getOrchestratorState().phase).toBe("os-verifying");
	expect(f.intentStore.read()).toBeNull();
	f.effects.healthy = true;
	await runOrchestratorTick();
	// Then verified publication clears the path without any obsolete authority.
	expect(phases).toContain("sync-eligible");
	expect(getOrchestratorState().phase).toBe("idle");
	expect(getOrchestratorState().osStageRecovery).toBeUndefined();
	expect(f.intentStore.read()).toBeNull();
	await f.restart(observe);
	expect(getOrchestratorState().phase).toBe("idle");
});

test("publishing rename with failed first-write fsync is restorable by the in-process tick", async () => {
	// Given first intent rename landed, but publication never advanced to agent dispatch.
	const f = lifecycleFixture();
	fixtures.push(f);
	let fault = true;
	const store = new OsAttemptIntentStore({
		...f.intentStore.storage,
		syncParent: (path) => {
			if (fault && f.intentStore.read()?.phase === "publishing")
				throw new Error("first intent parent fsync");
			syncOrchestratorDirectory(path);
		},
	});
	await f.offer({ osAttemptIntentStore: store });
	const before = getOrchestratorState();
	expect((await installUpdatesNow()).started).toBe(false);
	expect(await loadOrchestratorState(f.file)).toEqual(before);
	expect(store.read()?.phase).toBe("publishing");
	// When storage recovers and the tick re-enters the normal recovery seam.
	fault = false;
	await runOrchestratorTick();
	// Then exact baseline/intent cleanup permits the next Install immediately.
	expect(getOrchestratorState()).toEqual(before);
	expect(store.read()).toBeNull();
	expect(f.effects.stages).toBe(0);
	expect((await installUpdatesNow()).started).toBe(true);
	expect(f.effects.stages).toBe(1);
	await f.restart();
	expect(f.intentStore.read()).toBeNull();
});
