import { afterEach, expect, test } from "bun:test";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const rollbackFails of [false, true]) {
	test(`parent-directory fsync failure reverts an unlaunched attempt (rollback pending=${rollbackFails})`, async () => {
		// Given a discovered offer and a fault after agent.json rename, before parent fsync.
		const f = runtimeFixture();
		fixtures.push(f);
		setOrchestratorRuntimeDepsForTest(f.deps);
		await checkUpdatesNow();
		const before = getOrchestratorState();
		let fault = true;
		let stages = 0;
		setOrchestratorRuntimeDepsForTest({
			...f.deps,
			stageOs: async () => {
				stages++;
			},
			persist: (snapshot) =>
				saveOrchestratorState(snapshot, f.file, (path) => {
					if (fault && (snapshot.phase === "os-staging" || rollbackFails))
						throw new Error("parent fsync fault");
					syncOrchestratorDirectory(path);
				}),
		});
		// When initial publication fails, and later storage recovers.
		expect((await installUpdatesNow()).started).toBe(false);
		expect(stages).toBe(0);
		expect(getOrchestratorState()).toEqual(before);
		if (rollbackFails)
			await expect(installUpdatesNow()).rejects.toMatchObject({
				data: { retryable: true },
			});
		fault = false;
		if (rollbackFails) await runOrchestratorTick();
		// Then no unsafe record or round was invented; the next Install launches normally.
		expect(await loadOrchestratorState(f.file)).toEqual(before);
		expect(getOrchestratorState().osStageRecovery).toBeUndefined();
		expect((await installUpdatesNow()).started).toBe(true);
		expect(stages).toBe(1);
	});
}
