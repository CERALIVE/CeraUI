import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOsStageJobOwner } from "../../modules/system/update-orchestrator/os-stage-job.ts";
import {
	prepareOsStageJob,
	readOsStageJob,
	writePrivateOsJobFile,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	type OsOrphanDeps,
	settleOsStageOrphan,
} from "../../modules/system/update-orchestrator/os-stage-orphan.ts";
import { acquireOsOrphanLock } from "../../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import { reconcileOsStageStartup } from "../../modules/system/update-orchestrator/os-stage-startup.ts";
import { absentUnit, exitedUnit, record } from "./os-stage-orphan-record.ts";
import { orphanScope, scopedOrphanLock } from "./os-stage-orphan-scope.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";
import { shippedOsStageGuard } from "./os-stage-test-guard.ts";

export async function orphanHarness(
	window: "prelaunch" | "released" | "directory",
) {
	const scope = orphanScope();
	const { signal } = scope.cancel;
	const root = await mkdtemp(join(tmpdir(), "ceraui-orphan-"));
	scope.roots.push(root);
	signal.throwIfAborted();
	const directory = join(root, "job");
	const lockPath = join(root, "update.lock");
	const uid = process.getuid?.() ?? -1;
	const job =
		window === "released"
			? { ...record, launched: true, lifecycle: "releasing" as const }
			: record;
	if (window === "directory") await mkdir(directory, { mode: 0o700 });
	else await prepareOsStageJob(job, directory, uid);
	if (window === "released") {
		await Bun.write(join(directory, "ready"), `${record.attemptId}\n`, {
			mode: 0o600,
		});
		writePrivateOsJobFile("release", `${record.attemptId}\n`, directory);
		await chmod(join(directory, "ready"), 0o600);
	}
	let unit = window === "released" ? exitedUnit() : absentUnit();
	const effects: string[] = [];
	const lockReadings: number[] = [];
	const contender = async () => {
		signal.throwIfAborted();
		const child = Bun.spawn(
			["flock", "-n", "-E", "75", "-x", lockPath, "true"],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		const abort = () => child.kill();
		signal.addEventListener("abort", abort, { once: true });
		scope.joins.push(child.exited);
		try {
			const result = await child.exited;
			signal.throwIfAborted();
			return result;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
	const acquireLock = () =>
		scopedOrphanLock(scope, () =>
			acquireOsOrphanLock({ lock: lockPath, helper: shippedOsStageGuard }),
		);
	const acquireControl = () =>
		scopedOrphanLock(scope, acquireTestOsStageControl);
	const deps: OsOrphanDeps = {
		kernel: async () => true,
		acquireControl,
		unlaunched: {
			kernel: async () => true,
			pinClean: async () => true,
			outcomesAbsent: async () => true,
			witness: () => undefined,
		},
		directory,
		uid,
		lock: acquireLock,
		run: async (argv) => {
			signal.throwIfAborted();
			if (argv[0] === "busctl")
				return { exitCode: 0, stdout: '(uo) 0 "/"', stderr: "" };
			if (argv[1] === "stop") {
				effects.push("stop-owned-exited-unit");
				unit = absentUnit();
			}
			return {
				exitCode: 0,
				stdout:
					argv[3] === "--property=LoadState"
						? unit
								.split("\n")
								.filter((line) => line.startsWith("LoadState="))
								.join("\n")
						: unit,
				stderr: "",
			};
		},
		observe: async () => {
			signal.throwIfAborted();
			return record.baseline;
		},
		cliGone: async () => {
			signal.throwIfAborted();
			return true;
		},
		liveProducer: () => null,
		sweep: async () => {
			lockReadings.push(await contender());
			effects.push("sweep-under-flock");
		},
	};
	const reconcile = (overrides: Partial<OsOrphanDeps> = {}) =>
		reconcileOsStageStartup({
			acquireControl,
			readJob: () => {
				signal.throwIfAborted();
				return readOsStageJob(directory, uid);
			},
			run: deps.run,
			observe: deps.observe,
			cliGone: async () => deps.cliGone(),
			owner: (value) =>
				createOsStageJobOwner(value, {
					inspect: async () => ({ kind: "absent" }),
					directory,
					uid,
					run: deps.run,
					now: () => performance.now(),
					sleep: (ms) => Bun.sleep(ms),
				}),
			orphan: (value, control) =>
				settleOsStageOrphan(value, {
					...deps,
					...overrides,
					...(control ? { control } : {}),
				}),
			restart: async () => {
				effects.push("forbidden-restart");
			},
			sweep: deps.sweep,
			liveProducer: () => null,
		});
	return {
		directory,
		uid,
		lockReadings,
		reconcile,
		contender,
		effects,
		acquireLock,
		orphan: async () =>
			settleOsStageOrphan(await readOsStageJob(directory, uid), deps),
		setUnit: (value: string) => {
			unit = value;
		},
	};
}
