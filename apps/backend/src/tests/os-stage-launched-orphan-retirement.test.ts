import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareOsStageJob,
	readOsStageJob,
	writePrivateOsJobFile,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import {
	absentUnit,
	exitedUnit,
	record,
} from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test.each([
	"stop",
	"reset",
	"absence",
	"job",
	"kernel",
	"replacement",
	"safe",
] as const)(
	"launched acknowledged orphan retains provenance until %s cleanup is proved",
	async (fault) => {
		// Given stop may succeed without unloading the terminal guardian.
		const root = await mkdtemp(join(tmpdir(), "ceraui-launched-orphan-"));
		const directory = join(root, "job");
		const uid = process.getuid?.() ?? -1;
		const job = { ...record, launched: true, lifecycle: "releasing" as const };
		let unit = exitedUnit();
		const commands: string[] = [];
		try {
			await prepareOsStageJob(job, directory, uid);
			await writeFile(join(directory, "ready"), `${job.attemptId}\n`, {
				mode: 0o600,
			});
			writePrivateOsJobFile("release", `${job.attemptId}\n`, directory);
			// When reconciliation requests checked terminal retirement.
			const action = settleOsStageOrphan(await readOsStageJob(directory, uid), {
				acquireControl: acquireTestOsStageControl,
				directory,
				uid,
				lock: async () => ({
					held: () => true,
					[Symbol.asyncDispose]: async () => {},
				}),
				observe: async () => job.baseline,
				cliGone: async () => true,
				liveProducer: () => null,
				sweep: async () => {},
				kernel: async () => fault !== "kernel",
				run: async (argv) => {
					const verb = argv[1] ?? "";
					if (argv[0] === "busctl")
						return {
							exitCode: 0,
							stdout:
								fault === "job"
									? '(uo) 77 "/org/freedesktop/systemd1/job/77"'
									: '(uo) 0 "/"',
							stderr: "",
						};
					commands.push(verb);
					if (verb === "stop" && fault === "replacement")
						unit = unit.replace("a".repeat(32), "b".repeat(32));
					if (verb === "reset-failed" && fault === "safe") unit = absentUnit();
					return {
						exitCode:
							(verb === "stop" && fault === "stop") ||
							(verb === "reset-failed" && fault === "reset")
								? 1
								: 0,
						stdout: unit,
						stderr: "",
					};
				},
			});
			// Then only scoped reset plus positive absence permits deletion.
			if (fault === "safe") {
				expect(await action).toBe(true);
				expect(commands).toContain("reset-failed");
				expect(await readOsStageJob(directory, uid)).toBeNull();
			} else {
				await expect(action).rejects.toHaveProperty(
					"reason",
					"rauc_recovery_unproven",
				);
				expect(await readOsStageJob(directory, uid)).toEqual(job);
				if (fault === "job" || fault === "kernel")
					expect(commands).not.toContain("stop");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
