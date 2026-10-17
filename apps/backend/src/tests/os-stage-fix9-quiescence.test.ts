import { expect, test } from "bun:test";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { observeQuiescence } from "../modules/system/update-orchestrator/os-stage-quiescence-wait.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";
import { baseline } from "./helpers/os-stage-run-inputs.ts";

test("post-cleanup quiescence re-observes census drift within its existing lifetime", async () => {
	// Given the same drifted observer used by startup and orphan post-cleanup proofs.
	const fixture = censusDriftFixture("resource");
	const tracked = {
		processes: new Set<string>(),
		resources: new Set<string>(),
	};
	let now = 0;
	// When quiescence waits under one absolute deadline and held authority.
	const proof = await observeQuiescence({
		ownership: { ...tracked, baseline },
		observe: (report) => observeRaucStage(tracked, fixture.deps, report),
		cliSettled: async () => true,
		lockHeld: async () => true,
		requireNewInstance: true,
		wait: {
			now: () => now,
			deadline: 300,
			sleep: async (ms) => {
				now += ms;
			},
			assert: async () => undefined,
		},
	});
	// Then only the later stable, resource-empty snapshot grants physical proof.
	expect(proof.resources).toEqual([]);
	expect(fixture.censuses()).toBe(4);
	expect(now).toBe(100);
});
