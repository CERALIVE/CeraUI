import { afterEach, expect, test } from "bun:test";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { loadOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { lifecycleFixture } from "./helpers/os-attempt-lifecycle-fixture.ts";

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const restart of [false, true]) {
	test(`publishing authority refuses a third snapshot after first-write fsync failure${restart ? " and restart" : ""}`, async () => {
		// Given an intent rename without acknowledged publication or any producer.
		const f = lifecycleFixture();
		fixtures.push(f);
		let fault = true;
		const store = new OsAttemptIntentStore({
			...f.intentStore.storage,
			syncParent: (path) => {
				if (fault) throw new Error("intent directory IO");
				syncOrchestratorDirectory(path);
			},
		});
		await f.offer({ osAttemptIntentStore: store });
		const before = getOrchestratorState();
		await installUpdatesNow();
		expect(() => allowCellularOnce("different-candidate")).toThrow(
			"retry shortly",
		);
		if (restart) {
			await expect(
				f.restart({
					osAttemptIntentStore: store,
					proveOsWriterQuiescent: async () => false,
				}),
			).rejects.toThrow();
		}
		// When a different grant tries to change the retained exact baseline.
		expect(() => allowCellularOnce("different-candidate")).toThrow(
			"retry shortly",
		);
		// Then no third snapshot exists; repair restores admission without a stage.
		expect(await loadOrchestratorState(f.file)).toEqual(before);
		expect(f.effects.stages).toBe(0);
		expect(store.read()?.phase).toBe("publishing");
		fault = false;
		if (restart) await f.restart({ osAttemptIntentStore: store });
		else await runOrchestratorTick();
		expect(store.read()).toBeNull();
		allowCellularOnce("different-candidate");
		expect((await loadOrchestratorState(f.file))?.cellularOverrideId).toBe(
			"different-candidate",
		);
	});
}

test("unproven publishing recovery keeps every manual update mutation closed", async () => {
	// Given a failed first-write acknowledgement and unavailable writer proof.
	const f = lifecycleFixture();
	fixtures.push(f);
	const store = new OsAttemptIntentStore({
		...f.intentStore.storage,
		syncParent: () => {
			throw new Error("intent directory IO");
		},
	});
	await f.offer({
		osAttemptIntentStore: store,
		proveOsWriterQuiescent: async () => false,
	});
	const before = getOrchestratorState();
	await installUpdatesNow();
	// When all mutation entrypoints and the tick encounter unresolved authority.
	expect(() => allowCellularOnce("different-candidate")).toThrow();
	await expect(checkUpdatesNow()).rejects.toMatchObject({
		code: "UPDATE_ORCHESTRATOR_INITIALIZING",
		data: { retryable: true },
	});
	await expect(installUpdatesNow()).rejects.toMatchObject({
		code: "UPDATE_ORCHESTRATOR_INITIALIZING",
		data: { retryable: true },
	});
	await runOrchestratorTick();
	// Then recovery owns the unchanged snapshot, not discovery or the scheduler.
	expect(await loadOrchestratorState(f.file)).toEqual(before);
	expect(f.effects.stages).toBe(0);
});
