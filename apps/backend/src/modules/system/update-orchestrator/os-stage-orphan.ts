import { lstat } from "node:fs/promises";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import type { RoutingCleanup } from "../update-transport/pin-rules.ts";
import {
	acquireOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import {
	assertStageDeadline,
	createStageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import {
	isOsStageGuardJobIdle,
	observeOsStageGuard,
} from "./os-stage-guard-observation.ts";
import { retireReleasedOsStageGuard } from "./os-stage-guard-retirement.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import {
	OS_STAGE_JOB_DIR,
	type OsStageJobRecord,
	readOsStageJob,
	retireOsStageJob,
} from "./os-stage-job-files.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import { inspectOsStageOrphan } from "./os-stage-orphan-inspection.ts";
import { acquireOsOrphanLock } from "./os-stage-orphan-lock.ts";
import { observeQuiescence } from "./os-stage-quiescence-wait.ts";
import {
	type OsUnlaunchedDeps,
	settleOsStageUnlaunched,
} from "./os-stage-unlaunched.ts";
import { defaultOsUnlaunchedEffects } from "./os-stage-unlaunched-effects.ts";

export type OsOrphanDeps = {
	readonly control?: OsStageControlLease;
	readonly acquireControl?: typeof acquireOsStageControlLease;
	readonly unlaunched?: Partial<OsUnlaunchedDeps>;
	readonly directory: string;
	readonly uid: number;
	readonly lock: typeof acquireOsOrphanLock;
	readonly run: typeof spawnWithTimeout;
	readonly observe: typeof observeRaucStage;
	readonly cliGone: () => Promise<boolean>;
	readonly sweep: (cleanup?: RoutingCleanup) => Promise<void>;
	readonly liveProducer: () => string | null;
	readonly kernel?: typeof proveOsGuardKernelOwnership;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
};

export async function settleOsStageOrphan(
	record: OsStageJobRecord | null,
	deps: OsOrphanDeps,
): Promise<boolean> {
	await using acquired = deps.control
		? null
		: await (deps.acquireControl ?? acquireOsStageControlLease)();
	const control = deps.control ?? acquired;
	if (!control?.held()) throw new OsStageError("rauc_recovery_unproven");
	if (record && !record.launched) {
		await settleOsStageUnlaunched(record, {
			...defaultOsUnlaunchedEffects,
			...deps,
			control,
			producerPresent: () => deps.liveProducer() !== null,
			inspect: (attemptId) => observeOsStageGuard(deps.run, attemptId),
			jobIdle: () => isOsStageGuardJobIdle(deps.run),
			...deps.unlaunched,
		});
		return true;
	}
	const directory = deps.directory;
	const beforeDir = await lstat(directory).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	});
	if (!beforeDir) {
		if (record) throw new OsStageError("rauc_recovery_unproven");
		return false;
	}
	await using lock = await deps.lock();
	const assertOwner = async () => {
		const currentDir = await lstat(directory);
		if (
			!lock.held() ||
			!control.held() ||
			deps.liveProducer() !== null ||
			!currentDir.isDirectory() ||
			currentDir.isSymbolicLink() ||
			currentDir.uid !== deps.uid ||
			(currentDir.mode & 0o777) !== 0o700 ||
			currentDir.ino !== beforeDir.ino ||
			currentDir.dev !== beforeDir.dev ||
			JSON.stringify(await readOsStageJob(directory, deps.uid)) !==
				JSON.stringify(record)
		)
			throw new OsStageError("rauc_recovery_unproven");
	};
	const inspect = () => inspectOsStageOrphan(record, deps);
	const now = deps.now ?? (() => performance.now());
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const deadline = now() + 10_000;
	const budget = createStageDeadline({
		deadline,
		now,
		fence: () => {
			if (!control.held() || !lock.held() || deps.liveProducer() !== null)
				throw new OsStageError("rauc_recovery_unproven");
		},
	});
	const read = <T>(work: () => Promise<T>) => withinStageDeadline(budget, work);
	await read(assertOwner);
	await read(inspect);
	const tracked = {
		processes: new Set(record?.processes ?? []),
		resources: new Set(record?.resources ?? []),
	};
	const baseline =
		record?.baseline ?? (await read(() => deps.observe(tracked)));
	if (!baseline) throw new OsStageError("rauc_recovery_unproven");
	const prove = async () => {
		await observeQuiescence({
			ownership: { ...tracked, baseline },
			observe: (report) => deps.observe(tracked, undefined, report),
			cliSettled: deps.cliGone,
			lockHeld: async () => lock.held(),
			requireNewInstance: record?.requireNewInstance ?? false,
			wait: {
				now,
				sleep,
				deadline,
				invalidate: budget.invalidate,
				assert: assertOwner,
				previousInstance: baseline.instance,
			},
		});
	};
	await read(prove);
	await read(() => deps.sweep(read));
	await read(prove);
	await read(inspect);
	await read(assertOwner);
	if (record) {
		const kernel = deps.kernel ?? proveOsGuardKernelOwnership;
		await read(() =>
			retireReleasedOsStageGuard({
				attemptId: record.attemptId,
				run: deps.run,
				inspect: async () => {
					await read(assertOwner);
					return observeOsStageGuard(deps.run, record.attemptId);
				},
				kernel: (input) =>
					kernel({ ...input, ...(lock.pid ? { temporaryPid: lock.pid } : {}) }),
				jobIdle: () => isOsStageGuardJobIdle(deps.run),
				now,
				sleep,
				budget,
			}),
		);
	}
	await read(assertOwner);
	assertStageDeadline(budget);
	await read(() => retireOsStageJob(directory));
	return true;
}

export const defaultOsOrphanEffects = {
	directory: OS_STAGE_JOB_DIR,
	uid: 0,
	lock: acquireOsOrphanLock,
	run: spawnWithTimeout,
	observe: observeRaucStage,
	cliGone: () => osInstallClientsGone(),
};
