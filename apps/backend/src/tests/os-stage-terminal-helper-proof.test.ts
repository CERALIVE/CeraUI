import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	type OsStageRunDeps,
	runOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-run.ts";
import { UpdateTransferError } from "../modules/system/update-transport/pin.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest, ranking } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("exhausted three-pair cleanup waits for fresh helper retirement instead of converting transport failure to unsafe", async () => {
	// Given all three distinct installs fail and their writer recoveries prove clean.
	const h = await harness();
	let cleaning = false;
	let retired = false;
	const deps: OsStageRunDeps<string> = {
		...h.deps,
		selection: async () => ranking(["wlan0", "eth0", "wwan0"]),
		attempt: (input) => {
			const attempt = h.deps.attempt(input);
			return {
				...attempt,
				outcome: Promise.resolve({
					kind: "failed" as const,
					error: new OsStageError("os_transport_failed"),
					transfer: new UpdateTransferError("no-route"),
				}),
			};
		},
		pin: {
			...h.deps.pin,
			run: async (job, selected, step, control) => {
				try {
					return await h.deps.pin.run(job, selected, step, control);
				} finally {
					cleaning = true;
				}
			},
		},
		observe: async (...args) => {
			const snapshot = await h.deps.observe(...args);
			return cleaning && !retired && snapshot
				? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
				: snapshot;
		},
		sleep: async (ms) => {
			retired = true;
			await h.deps.sleep(ms);
		},
	};
	// When a read-side child appears only at the terminal no-publication cleanup.
	await expect(runOsStageJob(manifest, h.control, deps)).rejects.toMatchObject({
		reason: "os_transport_failed",
		mode: "automatic",
	});
	// Then safe cleanup preserves the original failure and does not allocate another pair.
	expect(h.attempts()).toBe(3);
	expect(h.events).toContain("release");
	expect(h.events).not.toContain("receipt+serial+OS_STAGED");
});
