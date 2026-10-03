import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsStageGuardObservation } from "../../modules/system/update-orchestrator/os-stage-guard-observation.ts";
import {
	type OsStageJobRecord,
	prepareOsStageJob,
	readOsJobFile,
	readOsStageJob,
	writeOsStageJob,
	writePrivateOsJobFile,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	type OsUnlaunchedDeps,
	settleOsStageUnlaunched,
} from "../../modules/system/update-orchestrator/os-stage-unlaunched.ts";
import { record } from "./os-stage-orphan-record.ts";

export async function unlaunchedHarness(
	shape: "live" | "absent" | "terminal" | "starting" = "live",
	identity: Partial<
		Pick<OsStageJobRecord, "attemptId" | "candidateKey" | "baseline">
	> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "ceraui-unlaunched-"));
	const directory = join(root, "job");
	const uid = process.getuid?.() ?? -1;
	const job = {
		...record,
		...identity,
		launched: false,
		lifecycle: "acquiring" as const,
		requireNewInstance: false,
		resources: [],
	};
	await prepareOsStageJob(job, directory, uid);
	if (shape === "live")
		await writeFile(join(directory, "ready"), `${job.attemptId}\n`, {
			mode: 0o600,
		});
	const invocationId = "a".repeat(32);
	let unit: OsStageGuardObservation =
		shape === "live"
			? { kind: "live", pid: "100", invocationId }
			: shape === "absent"
				? { kind: "absent" }
				: shape === "starting"
					? { kind: "starting", invocationId }
					: { kind: "terminal", cleanExit: false, invocationId, exitStatus: 9 };
	let now = 0;
	const effects: string[] = [];
	const witness = Promise.withResolvers<void>();
	const lease = {
		held: () => true,
		[Symbol.asyncDispose]: async () => Promise.resolve(),
	};
	const deps: OsUnlaunchedDeps = {
		directory,
		uid,
		control: lease,
		producerPresent: () => false,
		inspect: async () => {
			if (
				unit.kind === "live" &&
				(await readOsJobFile("release", directory, uid)) ===
					`${job.attemptId}\n`
			) {
				effects.push("normal-exit");
				unit = {
					kind: "terminal",
					cleanExit: true,
					invocationId,
					exitStatus: 0,
				};
			}
			return unit;
		},
		kernel: async () => true,
		lock: async () => lease,
		observe: async () => job.baseline,
		cliGone: async () => true,
		outcomesAbsent: async () => true,
		drain: async () => {
			effects.push("drain");
		},
		sweep: async () => {
			effects.push("sweep");
		},
		pinClean: async () => true,
		jobIdle: async () => true,
		run: async (argv) => {
			effects.push(argv[1] ?? "unknown");
			unit = { kind: "absent" };
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		witness: () => {
			effects.push("witness");
			witness.resolve();
		},
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	};
	return {
		directory,
		uid,
		job,
		deps,
		effects,
		settle: async (overrides: Partial<OsUnlaunchedDeps> = {}) => {
			const disk = await readOsStageJob(directory, uid);
			if (!disk) throw new Error("test job missing");
			return settleOsStageUnlaunched(disk, { ...deps, ...overrides });
		},
		setUnit: (next: OsStageGuardObservation) => {
			unit = next;
		},
		crash: async (release: boolean) => {
			writeOsStageJob({ ...job, lifecycle: "releasing" }, directory);
			if (release)
				writePrivateOsJobFile("release", `${job.attemptId}\n`, directory);
		},
		[Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
	};
}
