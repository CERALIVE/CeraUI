import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-install-clients.ts";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	prepareOsStageJob,
	readOsJobFile,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test.each(["launched success", "launched failure", "startup recovery"])(
	"release refuses a foreign flagged installer during %s",
	async (path) => {
		// Given an idle daemon observation that cannot see a foreign dispatch-capable CLI.
		const root = await mkdtemp(join(tmpdir(), "ceraui-release-clients-"));
		const directory = join(root, "job");
		const uid = process.getuid?.() ?? -1;
		const job = { ...record, launched: true, lifecycle: "held" as const };
		const commands: string[] = [];
		let published = false;
		let now = 0;
		const cliGone = (url?: string) =>
			osInstallClientsGone(url, {
				list: async () => ["777"],
				read: async () =>
					"/usr/bin/rauc\0--debug\0install\0https://images.ceralive.tv/other.raucb\0",
			});
		const run = async (argv: string[]) => {
			commands.push(argv.join(" "));
			return { exitCode: 0, stdout: "LoadState=loaded", stderr: "" };
		};
		try {
			await prepareOsStageJob(job, directory, uid);
			await writeFile(join(directory, "ready"), `${job.attemptId}\n`, {
				mode: 0o600,
			});
			const owner = createOsStageJobOwner(job, {
				directory,
				uid,
				run,
				cliGone: () => cliGone(),
				inspect: async () => ({
					kind: "live",
					pid: "100",
					invocationId: "a".repeat(32),
				}),
				kernel: async () => true,
				jobIdle: async () => true,
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			});
			const recovered = {
				...job.baseline,
				instance: "660:20",
				processes: ["660:20"],
			};
			// When success/failure or startup attempts to publish the shared release marker.
			const action =
				path === "startup recovery"
					? reconcileOsStageStartup({
							acquireControl: acquireTestOsStageControl,
							readJob: async () => job,
							owner: () => owner,
							run,
							cliGone,
							observe: async () => recovered,
							restart: async () => undefined,
							drain: async () => undefined,
							sweep: async () => undefined,
							now: () => now,
							sleep: async (ms) => {
								now += ms;
							},
							liveProducer: () => null,
						})
					: owner.release(
							job.baseline,
							true,
							path === "launched success"
								? () => {
										published = true;
									}
								: undefined,
						);
			await expect(action).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			// Then neither publication nor physical retirement is authorized; provenance survives.
			expect(published).toBe(false);
			expect(await readOsJobFile("release", directory, uid)).toBeNull();
			expect(await readOsStageJob(directory, uid)).not.toBeNull();
			expect(
				commands.some((command) => / stop | reset-failed /.test(command)),
			).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
