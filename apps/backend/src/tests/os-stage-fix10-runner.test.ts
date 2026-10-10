import { expect, test } from "bun:test";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";
import { unknownEvidenceFixture } from "./helpers/os-stage-fix10-unknown-fixture.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

test.each([
	"stable",
	"retiring-process",
	"appearing-process",
	"resource",
] as const)(
	"runner refuses a replacement after failed Operation with %s census",
	async (drift) => {
		// Given the production runner/controller; only replacement admission is faulty.
		const h = await harness();
		const source =
			drift === "stable" ? rockHelperFixture([]) : censusDriftFixture(drift);
		const fixture = unknownEvidenceFixture(source.deps, "operation-command");
		let armed = false;
		let sleeps = 0;
		// When a transport failure reaches next-pair admission with unknown evidence.
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				selection: async () => {
					if (h.attempts() === 1) armed = true;
					return h.deps.selection();
				},
				sleep: async (ms) => {
					sleeps++;
					await h.deps.sleep(ms);
				},
				observe: (tracked, deps, report) =>
					armed
						? observeRaucStage(tracked, fixture.deps, report)
						: h.deps.observe(tracked, deps, report),
			}),
		).rejects.toHaveProperty("mode", "unsafe");
		// Then simultaneous drift cannot erase a terminal failure or publish success.
		expect(h.attempts()).toBe(1);
		expect(h.events.filter((event) => event.startsWith("begin:"))).toEqual([
			"begin:wlan0/4",
		]);
		expect(h.events).not.toContain("receipt+serial+OS_STAGED");
		expect(h.events).not.toContain("release");
		expect(sleeps).toBe(0);
	},
);
