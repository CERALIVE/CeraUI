import { afterEach, expect, test } from "bun:test";
import {
	PendingPackageSuccessError,
	pendingPackageSuccess,
} from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { fencePackageSuccessEffects } from "../modules/system/update-orchestrator/pending-success-runtime.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import type { defaultOrchestratorRuntimeDeps } from "../modules/system/update-orchestrator/runtime.ts";
import { reconcileStaleUnits } from "../modules/system/update-orchestrator/stale-services.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

afterEach(() => pendingPackageSuccess.resetForTest());

function fencedFixture() {
	const f = runtimeFixture();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	saveOrchestratorState(baseline, f.file);
	pendingPackageSuccess.configure(
		{
			snapshot: () => baseline,
			pending: () => false,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: f.deps.persist,
		},
		() => {},
		() => 10,
	);
	pendingPackageSuccess.observe();
	return f;
}

test("pending success refuses every system-effect dependency before dispatch", async () => {
	// Given retained completion authority and injected mutation counters.
	const f = fencedFixture();
	let effects = 0;
	const called = async () => {
		effects++;
	};
	const gated = fencePackageSuccessEffects({
		...f.deps,
		startPackageInstall: () => {
			effects++;
			return { started: true };
		},
		stageOs: called,
		armOs: called,
		startSlotSync: called,
		resetSlotSyncFailure: called,
		cleanSlotSyncArchives: async () => {
			effects++;
			return true;
		},
		removeRaucDownloads: called,
		dropSupersededQuarantine: called,
		runPackageCheck: async () => {
			effects++;
			return null;
		},
		checkOsManifest: async () => {
			effects++;
			return {
				available: false,
				rateLimited: false,
				failed: false,
				reason: "",
			};
		},
		restartStale: async () => {
			effects++;
			return true;
		},
	});
	try {
		// When scheduler launch/discovery/restart entrypoints are called while fenced.
		const commands = [
			() => gated.startPackageInstall(),
			() => gated.stageOs(manifest, () => {}),
			() => gated.armOs(false),
			() => gated.startSlotSync(),
			() => gated.resetSlotSyncFailure(),
			() => gated.cleanSlotSyncArchives(),
			() => gated.removeRaucDownloads(),
			() => gated.dropSupersededQuarantine(f.deps.quarantine),
		];
		for (const command of commands)
			expect(command).toThrow("persistence pending");
		await expect(gated.runPackageCheck()).rejects.toThrow(
			"persistence pending",
		);
		await expect(gated.checkOsManifest()).rejects.toThrow(
			"persistence pending",
		);
		await expect(
			gated.restartStale(
				async () => true,
				() => false,
			),
		).rejects.toThrow("persistence pending");
		// Then none reaches the system, independently of health/readiness flags.
		expect(effects).toBe(0);
	} finally {
		f.cleanup();
	}
});

test("an awaited scheduler probe cannot return phase-overwrite authority after success appears", async () => {
	// Given discovery waiting on its settings input before success was observed.
	const f = fencedFixture();
	pendingPackageSuccess.resetForTest();
	const settings =
		Promise.withResolvers<
			Awaited<ReturnType<typeof defaultOrchestratorRuntimeDeps.loadSettings>>
		>();
	const gated = fencePackageSuccessEffects({
		...f.deps,
		loadSettings: () => settings.promise,
	});
	const probe = gated.loadSettings();
	const verdict = probe.then(
		() => null,
		(error: unknown) => error,
	);
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	pendingPackageSuccess.configure(
		{
			snapshot: () => baseline,
			pending: () => false,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: f.deps.persist,
		},
		() => {},
		() => 10,
	);
	try {
		// When completion arrives while the scheduler awaits that probe.
		pendingPackageSuccess.observe();
		settings.resolve(await f.deps.loadSettings());
		// Then no stale probe result can reach its caller's dispatch.
		expect(await verdict).toBeInstanceOf(PendingPackageSuccessError);
	} finally {
		f.cleanup();
	}
});

test("stale reconciliation rechecks the fence after idle awaits before restarting", async () => {
	// Given eligible stale ceralive mappings and an idle observation in flight.
	const f = fencedFixture();
	pendingPackageSuccess.resetForTest();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	pendingPackageSuccess.configure(
		{
			snapshot: () => baseline,
			pending: () => false,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: f.deps.persist,
		},
		() => {},
		() => 10,
	);
	const idle = Promise.withResolvers<boolean>();
	const awaiting = Promise.withResolvers<void>();
	let restarts = 0;
	const reconcile = reconcileStaleUnits({
		units: ["ceralive.service"],
		isIdle: () => {
			awaiting.resolve();
			return idle.promise;
		},
		transactionRunning: () => false,
		restart: async () => {
			restarts++;
		},
		recommend: () => {},
	});
	await awaiting.promise;
	try {
		// When pending success fences the already-running reconciliation.
		pendingPackageSuccess.observe();
		idle.resolve(true);
		// Then the positive idle answer still cannot submit a restart.
		expect(await reconcile).toBe(false);
		expect(restarts).toBe(0);
	} finally {
		idle.resolve(true);
		f.cleanup();
	}
});
