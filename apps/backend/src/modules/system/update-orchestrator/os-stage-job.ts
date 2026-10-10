import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import { retireContendedOsStageGuard } from "./os-stage-contention-cleanup.ts";
import {
	assertStageDeadline,
	type StageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import {
	OS_STAGE_GUARD_DESCRIPTION as DESCRIPTION,
	isOsStageGuardJobIdle,
	type OsStageGuardObservation,
	observeOsStageGuard,
} from "./os-stage-guard-observation.ts";
import { retireReleasedOsStageGuard } from "./os-stage-guard-retirement.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
	OS_STAGE_JOB_DIR,
	type OsStageJobRecord,
	prepareOsStageJob,
	readOsJobFile,
	retireOsStageJob,
	writeOsStageJob,
	writePrivateOsJobFile,
} from "./os-stage-job-files.ts";
import {
	type OsStageJobOwner,
	settleOwnedUnlaunched,
} from "./os-stage-job-owner.ts";
import { trackOsStagePrivateProvenance } from "./os-stage-launched-provenance.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";
import { proveOsStageRelease } from "./os-stage-release-proof.ts";
import type { OsUnlaunchedDeps } from "./os-stage-unlaunched.ts";

export {
	isOwnedOsStageGuard,
	OS_STAGE_GUARD_PROPERTIES,
} from "./os-stage-guard-observation.ts";
export type { OsStageJobOwner } from "./os-stage-job-owner.ts";

export type OsStageJobDeps = {
	readonly run: typeof spawnWithTimeout;
	readonly directory: string;
	readonly uid: number;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly unlaunched?: Partial<OsUnlaunchedDeps>;
	readonly kernel?: typeof proveOsGuardKernelOwnership;
	readonly jobIdle?: () => Promise<boolean>;
	readonly inspect?: () => Promise<OsStageGuardObservation>;
	readonly cliGone?: () => Promise<boolean>;
};
const defaults: OsStageJobDeps = {
	run: spawnWithTimeout,
	directory: OS_STAGE_JOB_DIR,
	uid: 0,
	now: () => performance.now(),
	sleep: (ms) => Bun.sleep(ms),
};

export function createOsStageJobOwner(
	record: OsStageJobRecord,
	deps: OsStageJobDeps = defaults,
): OsStageJobOwner {
	let current = record;
	let prepared = false;
	const inspect = () =>
		deps.inspect?.() ?? observeOsStageGuard(deps.run, record.attemptId);
	const kernel = deps.kernel ?? proveOsGuardKernelOwnership;
	const jobIdle = deps.jobIdle ?? (() => isOsStageGuardJobIdle(deps.run));
	const provenance = trackOsStagePrivateProvenance(deps.directory, deps.uid);
	const held = async () => {
		return withOsPhysicalSettlement(async () => {
			const observation = await inspect();
			const owned =
				observation.kind === "live" &&
				(await kernel({ pid: observation.pid, attemptId: record.attemptId })) &&
				(await readOsJobFile("ready", deps.directory, deps.uid)) ===
					`${record.attemptId}\n`;
			// An adopted owner (startup) first proves its directory here.
			if (owned && !provenance.captured()) await provenance.capture(current);
			return owned;
		});
	};
	async function acquire(): Promise<void> {
		const existing = await deps.run(
			["systemctl", "show", OS_STAGE_GUARD_UNIT, "--property=LoadState"],
			{ timeoutMs: 2_000 },
		);
		if (
			existing.exitCode !== 0 ||
			existing.stdout.trim() !== "LoadState=not-found"
		)
			throw new OsStageError("os_update_lock_held", { cause: existing });
		current = { ...record, lifecycle: "acquiring" };
		await prepareOsStageJob(current, deps.directory, deps.uid);
		prepared = true;
		await provenance.capture(current);
		const result = await deps.run(
			[
				"systemd-run",
				`--unit=${OS_STAGE_GUARD_UNIT}`,
				`--description=${DESCRIPTION}`,
				"--service-type=exec",
				"--property=RemainAfterExit=yes",
				"--property=StandardOutput=null",
				"--property=StandardError=journal",
				"/usr/bin/flock",
				"-n",
				"-E",
				"75",
				"-x",
				SOFTWARE_UPDATE_LOCK,
				OS_STAGE_GUARD_HELPER,
				record.attemptId,
			],
			{ timeoutMs: 10_000 },
		);
		if (result.exitCode !== 0)
			throw new OsStageError("rauc_recovery_unproven", { cause: result });
		const deadline = deps.now() + 10_000;
		do {
			const observation = await inspect();
			// The failed flock is ours, but retirement still needs positive absence.
			if (observation.kind === "terminal" && observation.exitStatus === 75) {
				await retireContendedOsStageGuard({
					...deps,
					record: current,
					inspect,
					kernel,
					jobIdle,
				});
				throw new OsStageError("os_update_lock_held");
			}
			if (await held()) {
				current = { ...current, lifecycle: "held" };
				writeOsStageJob(current, deps.directory);
				return;
			}
			await deps.sleep(100);
		} while (deps.now() < deadline);
		throw new OsStageError("rauc_recovery_unproven");
	}
	function remember(
		snapshot: RaucStageSnapshot,
		launched = true,
		cliSettled = false,
		requireNewInstance = false,
	): void {
		current = {
			...current,
			processes: [...new Set([...current.processes, ...snapshot.processes])],
			resources: [...new Set([...current.resources, ...snapshot.resources])],
			launched,
			cliSettled,
			requireNewInstance,
		};
		writeOsStageJob(current, deps.directory);
	}
	function beginAttempt(snapshot: RaucStageSnapshot, pair: string): void {
		current = {
			...current,
			baseline: snapshot,
			processes: [...snapshot.processes],
			resources: [],
			pair,
			launched: true,
			cliSettled: false,
			requireNewInstance: false,
		};
		writeOsStageJob(current, deps.directory);
	}
	async function release(
		snapshot: RaucStageSnapshot,
		pinClean: boolean,
		settle?: () => void,
		budget?: StageDeadline,
	): Promise<void> {
		const read = <T>(work: () => Promise<T>) =>
			budget ? withinStageDeadline(budget, work) : work();
		const assert = () => {
			if (budget) assertStageDeadline(budget);
		};
		await proveOsStageRelease({
			record: current,
			snapshot,
			pinClean,
			held,
			...(deps.cliGone ? { cliGone: deps.cliGone } : {}),
			provenance: () => provenance.assert(current, false),
			...(budget ? { budget } : {}),
		});
		assert();
		settle?.();
		await read(() =>
			withOsPhysicalSettlement(async () => {
				await read(() => provenance.assert(current, false));
				assert();
				current = { ...current, lifecycle: "releasing" };
				writeOsStageJob(current, deps.directory);
				writePrivateOsJobFile(
					"release",
					`${record.attemptId}\n`,
					deps.directory,
				);
				await read(() => provenance.assert(current, true));
				await retireReleasedOsStageGuard({
					...deps,
					inspect,
					kernel,
					jobIdle,
					attemptId: record.attemptId,
					...(budget ? { budget } : {}),
				});
				await read(() => provenance.assert(current, true));
				assert();
				await read(() => retireOsStageJob(deps.directory));
			}),
		);
	}
	return {
		acquire,
		held,
		assertAuthority: () =>
			withOsPhysicalSettlement(() => provenance.assert(current, false)),
		remember,
		beginAttempt,
		release,
		record: () => current,
		settleUnlaunched: async (control, effects = {}) => {
			if (!prepared) return false;
			await settleOwnedUnlaunched({
				record,
				current,
				control,
				effects: {
					directory: deps.directory,
					uid: deps.uid,
					run: deps.run,
					inspect: () => inspect(),
					kernel,
					jobIdle,
					...deps.unlaunched,
					...effects,
				},
			});
			return true;
		},
	};
}
