import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { logger } from "../helpers/logger.ts";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import {
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import { harness } from "./helpers/orchestrator-runtime-os-scheduler.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { baseline } from "./helpers/os-stage-run-inputs.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

test.each(["extras", "EACCES", "drift"] as const)(
	"settled event describes admission %s without private text or stored diagnostics",
	async (fault) => {
		// Given the actual observer, wait and runtime settlement, with a private read failure.
		let settledMeta: unknown;
		const warn = spyOn(logger, "warn").mockImplementation(
			(...args: unknown[]) => {
				if (args[0] === "update-orchestrator: OS staging attempt settled")
					settledMeta = args[1];
				return logger;
			},
		);
		const source = rockHelperFixture([]);
		const drift = censusDriftFixture("retiring-process", true);
		const failure = Object.assign(
			new Error("/private/secret token=hidden pid=999 argv"),
			{
				code: "EACCES",
			},
		);
		let now = 0;
		const h = harness([], {
			stageOs: async () => {
				await observeAdmission(
					(report) => {
						switch (fault) {
							case "extras":
								return Promise.resolve({
									...baseline,
									processes: [...baseline.processes, "helper:9"],
								});
							case "EACCES":
								return observeRaucStage(
									{ processes: new Set(), resources: new Set() },
									{
										...source.deps,
										read: async (path) => {
											if (path.endsWith("cgroup.procs")) throw failure;
											return source.deps.read(path);
										},
									},
									report,
								);
							case "drift":
								return observeRaucStage(
									{ processes: new Set(), resources: new Set() },
									drift.deps,
									report,
								);
							default:
								throw new Error(fault satisfies never);
						}
					},
					undefined,
					{
						now: () => now,
						deadline: 250,
						sleep: async (ms) => {
							now += ms;
						},
						assert: async () => undefined,
					},
				);
			},
		});
		try {
			// When the staging attempt fails through the production runtime.
			await runOrchestratorTick();
			// Then exported meta retains the closed first failure and wait measurements.
			const meta = settledMeta;
			expect(JSON.stringify(meta)).not.toContain("/private/");
			expect(JSON.stringify(meta)).not.toContain("hidden");
			expect(meta).toMatchObject({
				reason: "rauc_recovery_unproven",
				mode: "unsafe",
				diagnostics: {
					firstFailureStep: "admission",
					firstFailureReason: "rauc_recovery_unproven",
					firstFailurePredicate:
						fault === "extras" ? "extra-process" : "observation-unknown",
					attempts: fault === "EACCES" ? 1 : 3,
					elapsedMs: fault === "EACCES" ? 0 : 250,
				},
			});
			if (fault === "EACCES")
				expect(meta).toHaveProperty(
					"diagnostics.firstFailureObservation",
					"cgroup-processes: Error(EACCES):",
				);
			if (fault === "drift")
				expect(meta).toHaveProperty(
					"diagnostics.firstFailureObservation",
					"census-drift: unproven",
				);
			expect(JSON.stringify(h.persisted)).not.toContain("firstFailure");
		} finally {
			warn.mockRestore();
		}
	},
);

test("a thrown admission read preserves its identity and redacted diagnostics through wrapping", async () => {
	// Given an observer rejecting, rather than returning the usual null refusal.
	const failure = Object.assign(new Error("/private/credential"), {
		code: "EIO",
	});
	const result = await observeAdmission(
		async () => {
			throw failure;
		},
		undefined,
		{
			now: () => 0,
			deadline: 250,
			sleep: async () => undefined,
			assert: async () => undefined,
		},
	).catch((error: unknown) => error);
	// Then the existing throw contract is unchanged (context is tested by the runtime cases).
	expect(result).toBe(failure);
});
