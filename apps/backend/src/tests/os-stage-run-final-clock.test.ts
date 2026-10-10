import { afterEach, expect, spyOn, test } from "bun:test";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("signed candidate expiry at the final clock refuses after helper deferral despite a stale successful revalidator", async () => {
	// Given a candidate expires at 2,000 and its injected revalidator ignores time.
	const h = await harness();
	let wall = 1_000;
	let waiting = false;
	let retired = false;
	const clock = spyOn(Date, "now").mockImplementation(() => wall);
	try {
		// When the wait crosses signed expiry after the prior pair recovered.
		await expect(
			runOsStageJob(
				{ ...manifest, expires_at: new Date(2_000).toISOString() },
				h.control,
				{
					...h.deps,
					selection: async () => {
						waiting = h.attempts() === 1;
						return h.deps.selection();
					},
					observe: async (...args) => {
						const current = await h.deps.observe(...args);
						return waiting && !retired && current
							? { ...current, processes: [...current.processes, "helper:9"] }
							: current;
					},
					sleep: async (ms) => {
						retired = true;
						wall = 2_000;
						await h.deps.sleep(ms);
					},
				},
			),
		).rejects.toMatchObject({
			reason: "rauc_install_failed",
			diagnostics: { refusal: "signed-candidate-expired" },
		});
		// Then no second writer is dispatched on the earlier candidate validation.
		expect(h.attempts()).toBe(1);
	} finally {
		clock.mockRestore();
	}
});
