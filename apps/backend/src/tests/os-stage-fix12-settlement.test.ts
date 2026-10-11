import { expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	ensureOsUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { baseline, manifest } from "./helpers/os-stage-run-inputs.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

function deniedObserver() {
	const source = rockHelperFixture([]);
	return (
		tracked: Parameters<typeof observeRaucStage>[0],
		_deps?: Parameters<typeof observeRaucStage>[1],
		report?: Parameters<typeof observeRaucStage>[2],
	) =>
		observeRaucStage(
			tracked,
			{
				...source.deps,
				read: async (path) => {
					if (path.endsWith("cgroup.procs"))
						throw Object.assign(new Error("/private/secret argv pid=999"), {
							code: "EACCES",
						});
					return source.deps.read(path);
				},
			},
			report,
		);
}

test.each(["runner", "admission"] as const)(
	"%s first failure survives a failed unlaunched settlement proof",
	async (first) => {
		// Given a real private unlaunched record and runner; only the I/O ports are synthetic.
		await using u = await unlaunchedHarness("absent");
		const h = await harness();
		const error = new OsStageError("os_origin_unavailable");
		const result = await runOsStageJob(manifest, h.control, {
			...h.deps,
			owner: (input) => ({
				...h.deps.owner(input),
				settleUnlaunched: async () => {
					await u.settle({ observe: deniedObserver() });
					return true;
				},
			}),
			selection: async () => {
				if (first === "runner") throw error;
				return h.deps.selection();
			},
			revalidate: async () => {
				await observeAdmission(async () => ({
					...baseline,
					processes: [...baseline.processes, "helper:9"],
				}));
			},
		}).catch((cause: unknown) => cause);
		// Then final unsafe settlement retains the earlier reason/predicate, not its private cause.
		expect(result).toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
			diagnostics: {
				failureStep: "settlement-proof",
				firstFailureStep: first,
				firstFailureReason:
					first === "runner"
						? "os_origin_unavailable"
						: "rauc_recovery_unproven",
				firstFailurePredicate:
					first === "runner" ? "observation-unknown" : "extra-process",
				refusal: "observation-unknown",
				observation: "cgroup-processes: Error(EACCES):",
			},
		});
		if (!(result instanceof OsStageError))
			throw new Error("expected typed refusal");
		expect(JSON.stringify(result.diagnostics)).not.toContain("/private/");
		expect(u.effects).toEqual([]);
		expect(h.attempts()).toBe(0);
	},
);

test("unlaunched refusal carries the observation stage and errno without messages", async () => {
	// Given a persisted never-launched job and the actual observer's EACCES-to-null path.
	await using h = await unlaunchedHarness("absent");
	// When the physical settlement proof refuses.
	const error = await h
		.settle({ observe: deniedObserver() })
		.catch((cause: unknown) => cause);
	// Then diagnostics remain bounded and machine-describing, with no leaked read input.
	expect(error).toHaveProperty(
		"diagnostics.firstFailureStep",
		"settlement-proof",
	);
	expect(error).toHaveProperty(
		"diagnostics.firstFailureObservation",
		"cgroup-processes: Error(EACCES):",
	);
	if (!(error instanceof OsStageError))
		throw new Error("expected typed refusal");
	expect(JSON.stringify(error.diagnostics)).not.toContain("secret");
	expect(String(error.diagnostics.observation).length).toBeLessThanOrEqual(200);
});

test("startup unresolved warn exports redacted first-step diagnostics", async () => {
	// Given a real never-launched record; reconcile starts before the readiness callback joins it.
	await using h = await unlaunchedHarness("absent");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const logged = Promise.withResolvers<void>();
	let unresolvedMeta: unknown;
	const warn = spyOn(logger, "warn").mockImplementation(
		(...args: unknown[]) => {
			if (
				args[0] ===
				"update-orchestrator: startup writer recovery remains unresolved"
			) {
				unresolvedMeta = args[1];
				logged.resolve();
			}
			return logger;
		},
	);
	const deps = {
		acquireControl: async () => {
			entered.resolve();
			await release.promise;
			return h.deps.control;
		},
		readJob: async () => h.job,
		liveProducer: () => null,
		orphan: async () => {
			await h.settle({ observe: deniedObserver() });
			return true;
		},
	};
	try {
		const work = reconcileOsStageStartup(deps).catch((error: unknown) => error);
		await entered.promise;
		release.resolve();
		await work;
		// When the normal readiness path retries that unresolved startup.
		expect(ensureOsUpdateAdmissionReady(true, deps)).toBe(false);
		await logged.promise;
		// Then exported warn meta contains the proof failure, not only an opaque stack.
		const meta = unresolvedMeta;
		expect(meta).toHaveProperty(
			"diagnostics.firstFailureStep",
			"settlement-proof",
		);
		expect(meta).toHaveProperty("diagnostics.failureStep", "startup-recovery");
		expect(meta).toHaveProperty(
			"diagnostics.observation",
			"cgroup-processes: Error(EACCES):",
		);
		expect(JSON.stringify(meta)).not.toContain("/private/");
	} finally {
		release.resolve();
		warn.mockRestore();
	}
});
