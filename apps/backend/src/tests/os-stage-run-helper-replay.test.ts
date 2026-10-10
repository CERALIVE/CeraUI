import { afterEach, expect, test } from "bun:test";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test.each([
	["get-primary tree", ["877184", "877186"]],
	["get-state A", ["878794"]],
] satisfies readonly (readonly [string, readonly string[]])[])(
	"next-pair admission waits for the captured Rock %s to exit without another writer",
	async (_operation, pids) => {
		// Given recovery sees daemon-only; subsequent selection exposes captured children.
		const h = await harness();
		const fixture = rockHelperFixture(pids);
		let extraObservations = 0;
		let helpersShown = false;
		const deps = {
			...h.deps,
			observe: async (...args: Parameters<typeof observeRaucStage>) => {
				if (h.attempts() === 0) return h.deps.observe(...args);
				const snapshot = await observeRaucStage(args[0], fixture.deps, args[2]);
				if (snapshot && snapshot.processes.length > 1) extraObservations++;
				return snapshot;
			},
			selection: async () => {
				const selected = await h.deps.selection();
				if (h.attempts() === 1 && !helpersShown) {
					fixture.showHelpers();
					helpersShown = true;
				}
				return selected;
			},
			sleep: async (ms: number) => {
				expect(h.attempts()).toBe(1);
				expect(h.events).not.toContain("release");
				fixture.retireHelpers();
				await h.deps.sleep(ms);
			},
		};
		// When the real runner, observer and pin-controller execute the next pair.
		const receipt = await runOsStageJob(manifest, h.control, deps);
		// Then only one replacement install follows a freshly clean census.
		expect(receipt).toBe("receipt");
		expect(extraObservations).toBe(1);
		expect(h.events.filter((value) => value.startsWith("begin:"))).toEqual([
			"begin:wlan0/4",
			"begin:eth0/4",
		]);
		expect(h.attempts()).toBe(2);
	},
);
