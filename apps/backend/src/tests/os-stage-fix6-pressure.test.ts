import { expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest, ranking } from "./helpers/os-stage-run-inputs.ts";

test("recurrent proof deferrals retain the deadline without flooding the decision log", async () => {
	// Given a failed pair and repeated helper episodes after each refresh.
	const h = await harness();
	let revalidations = 0;
	let reads = 0;
	const log = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		// When the real runner repeatedly revalidates without a stable quiet dispatch boundary.
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				revalidate: async () => {
					revalidations++;
				},
				selection: async () => ranking([h.attempts() === 0 ? "wlan0" : "eth0"]),
				observe: async (...args) => {
					const sample = await h.deps.observe(...args);
					return revalidations >= 2 && sample && ++reads % 3 === 1
						? { ...sample, processes: [...sample.processes, "helper:9"] }
						: sample;
				},
			}),
		).rejects.toHaveProperty("mode", "unsafe");
		// Then sustained churn cannot emit a log for every refresh or grant a writer.
		expect(revalidations).toBeGreaterThan(100);
		expect(log.mock.calls.length).toBeLessThan(32);
		expect(h.attempts()).toBe(1);
	} finally {
		log.mockRestore();
	}
});
