import { expect, test } from "bun:test";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	fromPersisted,
	loadOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	awaitUpdateStartupAdjudication,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

for (const faultKind of ["unlink", "directory-sync"] as const) {
	test(`combined startup preserves ${faultKind} failure as transient until cleanup and cadence acknowledge`, async () => {
		// Given a real publishing crash whose retirement I/O cannot be acknowledged.
		const f = intentCrashFixture();
		const c = startupCadenceClock();
		let fault = true;
		class Store extends OsAttemptIntentStore {
			override retire(
				intent: Parameters<OsAttemptIntentStore["retire"]>[0],
			): void {
				if (fault && faultKind === "unlink")
					throw new Error("retirement unlink IO");
				super.retire(intent);
			}
		}
		const store = new Store({
			...f.intentStore.storage,
			syncParent: (path) => {
				if (fault) throw new Error("retirement directory-sync IO");
				syncOrchestratorDirectory(path);
			},
		});
		const deps = {
			...f.deps,
			osAttemptIntentStore: store,
			startupRetryClock: c.clock,
		};
		try {
			// When startup exhausts the finite burst on this known I/O closure.
			await expect(startUpdateOrchestrator(deps)).rejects.toThrow();
			// Then the error is not laundered into terminal safety permission or refusal.
			expect(c.delays).toEqual([250, 500, 1000, 2000, 4000]);
			expect(c.timers).toHaveLength(1);
			const timer = c.timers[0];
			if (!timer) throw new Error("cleanup must retain background startup");
			expect(timer.milliseconds).toBe(30_000);
			expect(timer.unreferenced).toBe(true);
			expect(() => allowCellularOnce("before-repair")).toThrow("initializing");
			fault = false;
			await timer.work();
			expect(await awaitUpdateStartupAdjudication()).toBe(true);
			expect(await loadOrchestratorState(f.file)).toEqual(
				fromPersisted(f.intent.before),
			);
			expect(store.read()).toBeNull();
			expect(() => allowCellularOnce("acknowledged")).not.toThrow();
			expect(c.timers).toHaveLength(1);
		} finally {
			f.cleanup();
		}
	});
}

test("combined startup does not retry a cause-free retirement authority refusal", async () => {
	// Given the same valid files, but an authoritative retirement refusal rather than I/O.
	const f = intentCrashFixture();
	const c = startupCadenceClock();
	class Store extends OsAttemptIntentStore {
		override retire(): void {
			throw new OsStageError("rauc_recovery_unproven");
		}
	}
	try {
		const bytes = await Bun.file(f.intentStore.storage.path).text();
		// When startup reaches that owner decision.
		await expect(
			startUpdateOrchestrator({
				...f.deps,
				osAttemptIntentStore: new Store(f.intentStore.storage),
				startupRetryClock: c.clock,
			}),
		).rejects.toThrow("rauc_recovery_unproven");
		// Then no cadence can turn it into authority to clear the file.
		expect(await awaitUpdateStartupAdjudication()).toBe(false);
		expect(c.delays).toEqual([]);
		expect(c.timers).toEqual([]);
		expect(await Bun.file(f.intentStore.storage.path).text()).toBe(bytes);
		expect(() => allowCellularOnce("unsafe")).toThrow("initializing");
	} finally {
		f.cleanup();
	}
});
