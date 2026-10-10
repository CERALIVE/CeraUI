import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

const untracked = {
	processes: new Set<string>(),
	resources: new Set<string>(),
};

test.each(["retiring-process", "appearing-process", "resource"] as const)(
	"re-observes %s drift without returning the changed pair",
	async (kind) => {
		// Given one drifted pair followed by a stable clean pair.
		const fixture = censusDriftFixture(kind);
		let now = 0;
		let deferrals = 0;
		const samples: Awaited<ReturnType<typeof observeRaucStage>>[] = [];
		// When admission uses the production observer and bounded proof wait.
		const proof = await observeAdmission(
			async (report) => {
				const snapshot = await observeRaucStage(
					untracked,
					fixture.deps,
					report,
				);
				samples.push(snapshot);
				return snapshot;
			},
			undefined,
			{
				now: () => now,
				deadline: 300,
				sleep: async (ms) => {
					now += ms;
				},
				assert: async () => undefined,
				deferred: () => {
					deferrals++;
				},
			},
		);
		// Then the drift itself never authorizes; only the next clean pair does.
		expect(samples[0]).toBeNull();
		expect(proof.processes).toEqual([proof.instance]);
		expect(proof.resources).toEqual([]);
		expect(deferrals).toBe(1);
		expect(fixture.censuses()).toBe(4);
	},
);

test("runner authorizes one replacement after a read helper retires between censuses", async () => {
	// Given the real runner/controller with captured helper stats and synthetic authority.
	const h = await harness();
	const fixture = censusDriftFixture("retiring-process");
	let armed = false;
	// When next-pair selection arms the helper's retirement barrier.
	const result = await runOsStageJob(manifest, h.control, {
		...h.deps,
		selection: async () => {
			if (h.attempts() === 1) armed = true;
			return h.deps.selection();
		},
		observe: (tracked, deps, report) =>
			armed
				? observeRaucStage(tracked, fixture.deps, report)
				: h.deps.observe(tracked, deps, report),
	});
	// Then the same job has exactly one replacement and publishes/releases normally.
	expect(result).toBe("receipt");
	expect(h.attempts()).toBe(2);
	expect(h.events.filter((event) => event.startsWith("begin:"))).toEqual([
		"begin:wlan0/4",
		"begin:eth0/4",
	]);
});

test("persistent census drift remains unsafe at the original deadline", async () => {
	// Given drift on every observation and no replenishment of the 250 ms budget.
	const fixture = censusDriftFixture("retiring-process", true);
	let now = 0;
	let deferrals = 0;
	// When every retry crosses the same deadline.
	await expect(
		observeAdmission(
			(report) => observeRaucStage(untracked, fixture.deps, report),
			undefined,
			{
				now: () => now,
				deadline: 250,
				sleep: async (ms) => {
					now += ms;
					if (now > 250)
						throw new Error("proof wait replenished the recovery budget");
				},
				assert: async () => undefined,
				deferred: () => {
					deferrals++;
				},
			},
		),
	).rejects.toHaveProperty("mode", "unsafe");
	// Then no proof escaped and the loop exhausted exactly its original remainder.
	expect(now).toBe(250);
	expect(deferrals).toBe(1);
	expect(fixture.censuses()).toBe(6);
});

test.each(["lease", "ownership"] as const)(
	"drift retry rechecks %s authority before the clean observation",
	async (authority) => {
		// Given valid authority on the first drifted sample, revoked during pacing.
		const fixture = censusDriftFixture("retiring-process");
		let now = 0;
		let held = true;
		// When the bounded loop would otherwise accept its next clean observation.
		await expect(
			observeAdmission(
				(report) => observeRaucStage(untracked, fixture.deps, report),
				undefined,
				{
					now: () => now,
					deadline: 300,
					sleep: async (ms) => {
						now += ms;
						held = false;
					},
					assert: async () => {
						if (!held)
							throw new OsStageError("rauc_recovery_unproven", {
								diagnostics: { refusal: authority },
							});
					},
				},
			),
		).rejects.toHaveProperty("diagnostics.refusal", authority);
		// Then no second observation was submitted under surrendered authority.
		expect(fixture.censuses()).toBe(2);
	},
);
