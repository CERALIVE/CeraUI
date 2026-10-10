import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	acquireOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import {
	isOsStageGuardJobIdle,
	OS_STAGE_GUARD_OBSERVATION_PROPERTIES,
	observeOsStageGuard,
	parseOsStageGuardObservation,
} from "./os-stage-guard-observation.ts";
import { retireReleasedOsStageGuard } from "./os-stage-guard-retirement.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import {
	OS_STAGE_GUARD_UNIT,
	OS_STAGE_JOB_DIR,
	type OsStageJobRecord,
	readOsJobFile,
	readOsStageJob,
	retireOsStageJob,
} from "./os-stage-job-files.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import { acquireOsOrphanLock } from "./os-stage-orphan-lock.ts";
import { observeQuiescence } from "./os-stage-quiescence-wait.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";
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
	readonly sweep: () => Promise<void>;
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
	const inspect = async () => {
		const unit = await deps.run(
			[
				"systemctl",
				"show",
				OS_STAGE_GUARD_UNIT,
				`--property=${OS_STAGE_GUARD_OBSERVATION_PROPERTIES}`,
			],
			{ timeoutMs: 2_000 },
		);
		if (unit.exitCode !== 0)
			throw new OsStageError("rauc_recovery_unproven", { cause: unit });
		const properties = parseOsStageSystemdProperties(unit.stdout);
		if (!properties) throw new OsStageError("rauc_recovery_unproven");
		const absent = properties.get("LoadState") === "not-found";
		const ready = await readOsJobFile("ready", directory, deps.uid);
		const release = await readOsJobFile("release", directory, deps.uid);
		if (!record) {
			if (!absent || ready !== null || release !== null)
				throw new OsStageError("rauc_recovery_unproven");
			const token = await readOsJobFile("token", directory, deps.uid);
			if (token !== null && !/^[a-f0-9-]{36}\n$/.test(token))
				throw new OsStageError("rauc_recovery_unproven");
			for (const name of await readdir(directory)) {
				if (
					name !== "token" &&
					!/^\.(?:token|job\.json)\.[a-f0-9-]{36}$/.test(name)
				)
					throw new OsStageError("rauc_recovery_unproven");
				const file = await lstat(join(directory, name));
				if (
					!file.isFile() ||
					file.isSymbolicLink() ||
					file.uid !== deps.uid ||
					file.nlink !== 1 ||
					(file.mode & 0o777) !== 0o600 ||
					file.size > 262144
				)
					throw new OsStageError("rauc_recovery_unproven");
			}
		} else {
			for (const name of await readdir(directory)) {
				if (
					!["token", "job.json", "ready", "release"].includes(name) &&
					!/^\.(?:token|job\.json|release)\.[a-f0-9-]{36}$/.test(name)
				)
					throw new OsStageError("rauc_recovery_unproven");
			}
			const preparing =
				!record.launched &&
				record.cliSettled &&
				ready === null &&
				release === null &&
				(record.lifecycle === undefined || record.lifecycle === "acquiring");
			const acknowledged =
				record.cliSettled &&
				ready === `${record.attemptId}\n` &&
				release === ready &&
				(record.lifecycle === undefined || record.lifecycle === "releasing");
			const observation = parseOsStageGuardObservation(
				unit.stdout,
				record.attemptId,
			);
			const exited =
				observation.kind === "terminal" &&
				observation.cleanExit &&
				["active", "inactive"].includes(properties.get("ActiveState") ?? "");
			if (!(absent && preparing) && !(acknowledged && (absent || exited)))
				throw new OsStageError("rauc_recovery_unproven", {
					diagnostics: { refusal: "orphan-lifecycle-unproven" },
				});
		}
		return absent;
	};
	await assertOwner();
	await inspect();
	const now = deps.now ?? (() => performance.now());
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const deadline = now() + 10_000;
	const tracked = {
		processes: new Set(record?.processes ?? []),
		resources: new Set(record?.resources ?? []),
	};
	const baseline = record?.baseline ?? (await deps.observe(tracked));
	if (!baseline) throw new OsStageError("rauc_recovery_unproven");
	const prove = async () => {
		await observeQuiescence({
			ownership: { ...tracked, baseline },
			observe: () => deps.observe(tracked),
			cliSettled: deps.cliGone,
			lockHeld: async () => lock.held(),
			requireNewInstance: record?.requireNewInstance ?? false,
			wait: {
				now,
				sleep,
				deadline,
				assert: assertOwner,
				previousInstance: baseline.instance,
			},
		});
	};
	await prove();
	await deps.sweep();
	await prove();
	await inspect();
	await assertOwner();
	if (now() >= deadline) throw new OsStageError("rauc_recovery_unproven");
	if (record) {
		const kernel = deps.kernel ?? proveOsGuardKernelOwnership;
		await retireReleasedOsStageGuard({
			attemptId: record.attemptId,
			run: deps.run,
			inspect: async () => {
				await assertOwner();
				return observeOsStageGuard(deps.run, record.attemptId);
			},
			kernel: (input) =>
				kernel({ ...input, ...(lock.pid ? { temporaryPid: lock.pid } : {}) }),
			jobIdle: () => isOsStageGuardJobIdle(deps.run),
			now: () => performance.now(),
			sleep: (ms) => Bun.sleep(ms),
		});
	}
	await assertOwner();
	await retireOsStageJob(directory);
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
