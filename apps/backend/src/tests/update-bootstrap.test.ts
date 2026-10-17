import { afterEach, expect, spyOn, test } from "bun:test";
import {
	guardNonCritical,
	retainUpdatePhysicalReconciliation,
} from "../helpers/boot-guard.ts";
import {
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
} from "../modules/system/software-updates.ts";
import { runUpdateBootstrap } from "../modules/system/update-bootstrap.ts";
import * as persistence from "../modules/system/update-orchestrator/persistence.ts";
import {
	awaitUpdateStartupAdjudication,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	retainUpdatePhysicalReconciliation(Promise.resolve(true));
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("held physical startup cannot let standalone recovery consume a finished committing unit first", async () => {
	// Given committing on disk, a finished unit and a held physical-reconcile promise.
	await using h = await updateHarness();
	const physical = Promise.withResolvers<boolean>();
	retainUpdatePhysicalReconciliation(physical.promise);
	const events: string[] = [];
	let unitPresent = true;
	const recover = () =>
		recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				if (!unitPresent) return null;
				events.push("consume-unit");
				unitPresent = false;
				onAttached?.();
				return { completion: Promise.resolve(0), wasAlreadyFinished: true };
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: recover,
		getPackageInstallWireState: getUpdateState,
	});
	const runtimeDeps = {
		...f.deps,
		persist: (snapshot) => {
			events.push(`persist:${snapshot.phase}`);
			persistence.saveOrchestratorState(snapshot, f.file);
		},
	} satisfies Parameters<typeof startUpdateOrchestrator>[0];
	fixtures.push(f);
	persistence.saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	const load = persistence.loadOrchestratorState;
	const reader = spyOn(persistence, "loadOrchestratorState").mockImplementation(
		async (...args) => {
			const snapshot = await load(...args);
			events.push(`read:${snapshot?.phase}`);
			return snapshot;
		},
	);
	try {
		// When the real bootstrap chain launches, unrelated boot work still proceeds.
		const completion = runUpdateBootstrap({
			start: async () => {
				await guardNonCritical("update-orchestrator", () =>
					startUpdateOrchestrator(runtimeDeps),
				);
				return awaitUpdateStartupAdjudication();
			},
			recover: async () => {
				events.push("standalone");
				await recover();
			},
			periodic: () => {
				events.push("periodic");
			},
		});
		await guardNonCritical("unrelated-boot", () => {
			events.push("unrelated");
		});
		expect(events).toEqual(["unrelated"]);
		expect(unitPresent).toBe(true);
		physical.resolve(true);
		await completion;
		await h.restarted();
		// Then the orchestrator reads/consumes/persists before the standalone handoff.
		expect(events.slice(0, 4)).toEqual([
			"unrelated",
			"read:committing",
			"consume-unit",
			"read:committing",
		]);
		expect(
			events.filter((event) => !event.startsWith("read:")).slice(-3),
		).toEqual(["persist:restarting-services", "standalone", "periodic"]);
		expect((await load(f.file))?.phase).toBe("restarting-services");
		expect(h.restarts).toBe(1);
	} finally {
		physical.resolve(true);
		await awaitUpdateStartupAdjudication();
		reader.mockRestore();
	}
});

test("startup refusal cannot authorize standalone recovery or periodic checks", async () => {
	// Given startup adjudicated as unsafe/maintenance-blocked rather than successful.
	const effects: string[] = [];
	// When the real chain receives that refusal.
	await runUpdateBootstrap({
		start: async () => false,
		recover: async () => {
			effects.push("recovery");
		},
		periodic: () => {
			effects.push("periodic");
		},
	});
	// Then the evidence remains reserved for maintenance; neither effect runs.
	expect(effects).toEqual([]);
});

test("periodic checks wait for standalone recovery completion", async () => {
	// Given initialized startup with standalone recovery still draining output.
	const draining = Promise.withResolvers<void>();
	const attached = Promise.withResolvers<void>();
	let periodic = false;
	// When the bootstrap reaches its second owner.
	const completion = runUpdateBootstrap({
		start: async () => true,
		recover: async () => {
			attached.resolve();
			await draining.promise;
		},
		periodic: () => {
			periodic = true;
		},
	});
	await attached.promise;
	// Then no refresh can race the drain, and completion starts it exactly afterwards.
	expect(periodic).toBe(false);
	draining.resolve();
	await completion;
	expect(periodic).toBe(true);
});
