import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-install-clients.ts";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import { readOsStageJob } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

test("contention cleanup retains the record when an unrelated flagged installer exists", async () => {
	// Given a failed acquisition and a foreign client outside daemon observation.
	await using h = await unlaunchedHarness("terminal");
	await rm(h.directory, { recursive: true });
	let absent = false;
	const effects: string[] = [];
	const owner = createOsStageJobOwner(h.job, {
		directory: h.directory,
		uid: h.uid,
		now: h.deps.now,
		sleep: h.deps.sleep,
		inspect: async () =>
			absent
				? { kind: "absent" }
				: {
						kind: "terminal",
						cleanExit: false,
						invocationId: "a".repeat(32),
						exitStatus: 75,
					},
		kernel: async () => true,
		jobIdle: async () => true,
		cliGone: () =>
			osInstallClientsGone(undefined, {
				list: async () => ["777"],
				read: async () =>
					"rauc\0--debug\0install\0https://images.ceralive.tv/other.raucb\0",
			}),
		run: async (argv) => {
			if (argv[1] === "stop") {
				absent = true;
				effects.push("stop");
			}
			return { exitCode: 0, stdout: "LoadState=not-found", stderr: "" };
		},
	});
	// When the real owner attempts terminal contention retirement.
	await expect(owner.acquire()).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
	// Then neither stop nor record retirement is authorized.
	expect(effects).toEqual([]);
	expect(await readOsStageJob(h.directory, h.uid)).not.toBeNull();
});
