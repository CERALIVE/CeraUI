import { expect, test } from "bun:test";
import { recoverRaucStage } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import { baseline } from "./helpers/os-stage-run-inputs.ts";

test("recovery refuses a reason-null observation when its final clock has expired", async () => {
	// Given old-writer retirement is clean but the observer itself consumed 360s.
	let now = 0;
	const ready = { ...baseline, instance: "new:3", processes: ["new:3"] };
	// When applying the recovery predicate after the slow read.
	await expect(
		recoverRaucStage(
			{
				baseline,
				processes: new Set(baseline.processes),
				resources: new Set(),
			},
			{
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
				cliSettled: () => true,
				lockHeld: async () => true,
				observe: async () => {
					now += 360_000;
					return ready;
				},
			},
			true,
		),
	).rejects.toMatchObject({ diagnostics: { refusal: "deadline-expired" } });
	// Then recovery returns no permission to launch another writer.
	expect(now).toBe(360_000);
});
