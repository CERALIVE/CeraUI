import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import { readOsStageJob } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { acquireOrSettleOsStage } from "../modules/system/update-orchestrator/os-stage-run-control.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

test.each([
	"stop",
	"reset-failed",
	"absence",
	"job",
	"kernel",
	"replacement",
] as const)(
	"contention cleanup retains provenance when %s fails",
	async (fault) => {
		await using h = await unlaunchedHarness("terminal");
		await rm(h.directory, { recursive: true });
		const terminal = {
			kind: "terminal",
			cleanExit: false,
			invocationId: "a".repeat(32),
			exitStatus: 75,
		} as const;
		h.setUnit(terminal);
		let stopped = false;
		const owner = createOsStageJobOwner(h.job, {
			cliGone: h.deps.cliGone,
			directory: h.directory,
			uid: h.uid,
			now: h.deps.now,
			sleep: h.deps.sleep,
			inspect: async () =>
				fault === "replacement" && stopped
					? { ...terminal, invocationId: "b".repeat(32) }
					: terminal,
			kernel: async () => fault !== "kernel",
			jobIdle: async () => fault !== "job",
			run: async (argv) => {
				if (argv[1] === "stop") stopped = true;
				return {
					exitCode: argv[1] === fault ? 1 : 0,
					stdout: "LoadState=not-found\n",
					stderr: "",
				};
			},
		});
		await expect(
			acquireOrSettleOsStage({ owner, lease: h.deps.control, effects: h.deps }),
		).rejects.toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
		});
		expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
			lifecycle: "acquiring",
			launched: false,
		});
		expect(await Bun.file(join(h.directory, "release")).exists()).toBe(false);
		if (fault === "reset-failed") {
			await h.settle();
			expect(h.effects).toContain("reset-failed");
			expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
		}
	},
);

test("proved terminal contention returns lock-held only after positive unit absence", async () => {
	await using h = await unlaunchedHarness("terminal");
	await rm(h.directory, { recursive: true });
	let absent = false;
	const commands: string[] = [];
	const owner = createOsStageJobOwner(h.job, {
		cliGone: h.deps.cliGone,
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
		run: async (argv) => {
			commands.push(argv[1] ?? "");
			if (argv[1] === "reset-failed") absent = true;
			return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
		},
	});
	await expect(owner.acquire()).rejects.toHaveProperty(
		"reason",
		"os_update_lock_held",
	);
	expect(commands).toContain("stop");
	expect(commands).toContain("reset-failed");
	expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
});
