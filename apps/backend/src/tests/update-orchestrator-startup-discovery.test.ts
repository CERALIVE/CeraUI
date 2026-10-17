import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { normalizeStartupDiscovery } from "../modules/system/update-orchestrator/startup-discovery.ts";
import {
	initialOrchestratorState,
	ORCHESTRATOR_PHASES,
} from "../modules/system/update-orchestrator/types.ts";
import {
	identifiedState,
	NOW,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const phase of ORCHESTRATOR_PHASES) {
	test(`startup discovery policy for ${phase} preserves terminal and recovery ownership`, () => {
		// Given every enumerated phase with nonzero history and a recovery record.
		const baseline = { ...identifiedState(), phase };
		// When startup's narrow discovery normalizer runs.
		const next = normalizeStartupDiscovery(baseline, NOW);
		// Then only checking changes phase/deadlines; history and recovery remain exact.
		if (phase !== "checking") expect(next).toBe(baseline);
		else {
			expect(next.phase).toBe("idle");
			expect(next.packageCheck).toEqual({
				...baseline.packageCheck,
				nextAttemptAt: NOW,
			});
			expect(next.osCheck).toEqual({ ...baseline.osCheck, nextAttemptAt: NOW });
			expect(next.osStageRecovery).toBe(baseline.osStageRecovery);
			expect(next.failureReason).toBe(baseline.failureReason);
		}
	});
}

for (const kind of ["packages", "os"] as const) {
	test(`persisted interrupted ${kind} check is durably idle and accepts a following Check`, async () => {
		// Given a persisted checking record with history to preserve, as after backend death.
		let checks = 0;
		const f = runtimeFixture({
			runPackageCheck: async () => {
				checks++;
				return null;
			},
			checkOsManifest: async () => ({
				available: false,
				failed: false,
				rateLimited: false,
				reason: "",
			}),
		});
		fixtures.push(f);
		const history = {
			lastAttemptAt: NOW - 1,
			lastSuccessAt: NOW - 1000,
			consecutiveFailures: 2,
			lastFailureWasRateLimited: true,
			nextAttemptAt: NOW + 100_000,
		};
		const baseline = {
			...initialOrchestratorState(0),
			phase: "checking" as const,
			packageCheck: { ...history },
			osCheck: { ...history },
			...(kind === "packages"
				? { packageCheck: { ...history, lastAttemptAt: NOW } }
				: { osCheck: { ...history, lastAttemptAt: NOW } }),
		};
		saveOrchestratorState(baseline, f.file);
		// When startup loads the interrupted phase.
		await startUpdateOrchestrator(f.deps);
		const settled = getOrchestratorState();
		// Then normalization is durable, preserves history and permits explicit discovery again.
		expect(settled).toEqual(normalizeStartupDiscovery(baseline, NOW));
		expect(await loadOrchestratorState(f.file)).toEqual(settled);
		expect((await checkUpdatesNow()).started).toBe(true);
		expect(checks).toBe(1);
	});
}

for (const phase of ORCHESTRATOR_PHASES) {
	test(`loads persisted ${phase} through its existing startup owner`, async () => {
		// Given an otherwise valid legacy record for each phase and absent effect units.
		const f = runtimeFixture();
		fixtures.push(f);
		const baseline = {
			...initialOrchestratorState(0),
			phase,
			failureReason:
				phase === "failed" || phase === "quarantined" ? "terminal" : null,
		};
		saveOrchestratorState(baseline, f.file);
		// When the real runtime starts from disk.
		await startUpdateOrchestrator(f.deps);
		// Then only the documented discovery, commit-uncertainty and sync-gate paths move it.
		const expected =
			phase === "checking" || phase === "sync-eligible"
				? "idle"
				: phase === "committing"
					? "failed"
					: phase;
		expect(getOrchestratorState().phase).toBe(expected);
		if (phase === "failed" || phase === "quarantined")
			expect(getOrchestratorState().failureReason).toBe("terminal");
	});
}

test("the next tick reruns interrupted discovery without counting a failed check", async () => {
	// Given both automation clocks otherwise delayed by a prior successful run.
	let checks = 0;
	const f = runtimeFixture({
		runPackageCheck: async () => {
			checks++;
			return null;
		},
	});
	fixtures.push(f);
	const baseline = {
		...initialOrchestratorState(0),
		phase: "checking" as const,
		packageCheck: {
			...initialOrchestratorState(0).packageCheck,
			lastSuccessAt: NOW - 1000,
			nextAttemptAt: NOW + 100_000,
		},
	};
	saveOrchestratorState(baseline, f.file);
	await startUpdateOrchestrator(f.deps);
	// When the first ordinary tick follows startup.
	await runOrchestratorTick();
	// Then package discovery ran, not a synthetic failure round.
	expect(checks).toBe(1);
	expect(getOrchestratorState().packageCheck.consecutiveFailures).toBe(0);
});
