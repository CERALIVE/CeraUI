import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import {
	createStageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import type { OsStageGuardObservation } from "./os-stage-guard-observation.ts";
import {
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
	retireOsStageJob,
	writeOsStageJob,
	writePrivateOsJobFile,
} from "./os-stage-job-files.ts";
import type { observeRaucStage } from "./os-stage-observation.ts";
import type { acquireOsOrphanLock } from "./os-stage-orphan-lock.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import type { drainRetainedOsStagePin } from "./os-stage-pin-retention.ts";
import { readOsStagePrivateOwner } from "./os-stage-private-owner.ts";
import { proveOsStageUnlaunched } from "./os-stage-unlaunched-proof.ts";
import type { writeOsUnlaunchedWitness } from "./os-stage-unlaunched-witness.ts";

export type OsUnlaunchedDeps = {
	readonly directory: string;
	readonly uid: number;
	readonly control: OsStageControlLease;
	readonly producerPresent: () => boolean;
	readonly inspect: (attemptId: string) => Promise<OsStageGuardObservation>;
	readonly kernel: typeof proveOsGuardKernelOwnership;
	readonly lock: typeof acquireOsOrphanLock;
	readonly observe: typeof observeRaucStage;
	readonly cliGone: () => Promise<boolean>;
	readonly outcomesAbsent: (record: OsStageJobRecord) => Promise<boolean>;
	readonly drain: typeof drainRetainedOsStagePin;
	readonly sweep: () => Promise<void>;
	readonly pinClean: () => Promise<boolean>;
	readonly jobIdle: () => Promise<boolean>;
	readonly run: typeof spawnWithTimeout;
	readonly witness: typeof writeOsUnlaunchedWitness;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
};

export async function settleOsStageUnlaunched(
	record: OsStageJobRecord,
	deps: OsUnlaunchedDeps,
): Promise<void> {
	return withOsPhysicalSettlement(() => settleUnlaunched(record, deps));
}

async function settleUnlaunched(
	record: OsStageJobRecord,
	deps: OsUnlaunchedDeps,
): Promise<void> {
	let current = record;
	const privateOwner = await readOsStagePrivateOwner({ ...deps, record });
	const assertOwner = async () => {
		if (!deps.control.held() || deps.producerPresent())
			throw new OsStageError("rauc_recovery_unproven");
		await privateOwner.assertOwner(current);
	};
	await assertOwner();
	let unit = await deps.inspect(record.attemptId);
	const deadline = deps.now() + 10_000;
	while (
		unit.kind === "starting" ||
		(unit.kind === "live" && (await privateOwner.tokens()).ready === null)
	) {
		if (deps.now() >= deadline)
			throw new OsStageError("rauc_recovery_unproven");
		await deps.sleep(100);
		await assertOwner();
		unit = await deps.inspect(record.attemptId);
	}
	const initialInvocation = unit.kind === "absent" ? null : unit.invocationId;
	const live = unit.kind === "live";
	if (!live && !(await deps.kernel({ pid: null, attemptId: record.attemptId })))
		throw new OsStageError("rauc_recovery_unproven");
	await using lock = live ? null : await deps.lock();
	const kernelGone = () =>
		deps.kernel({
			pid: null,
			attemptId: record.attemptId,
			...(lock?.pid ? { temporaryPid: lock.pid } : {}),
		});
	const proof = async () => {
		await assertOwner();
		const latest = await deps.inspect(record.attemptId);
		if (
			latest.kind === "starting" ||
			(latest.kind !== "absent" && latest.invocationId !== initialInvocation) ||
			(!live && latest.kind === "live")
		)
			throw new OsStageError("rauc_recovery_unproven");
		if (
			latest.kind === "terminal" &&
			(!(await deps.jobIdle()) || !(await kernelGone()))
		)
			throw new OsStageError("rauc_recovery_unproven");
		const held =
			latest.kind === "live"
				? await deps.kernel({ pid: latest.pid, attemptId: record.attemptId })
				: lock?.held() === true;
		const snapshot = proveOsStageUnlaunched({
			record: current,
			current: await deps.observe({
				processes: new Set(current.processes),
				resources: new Set(current.resources),
			}),
			clientsGone: await deps.cliGone(),
			outcomeAbsent: await deps.outcomesAbsent(current),
			lockHeld: held,
		});
		await assertOwner();
		return snapshot;
	};
	const tokens = await privateOwner.tokens();
	if (
		(tokens.ready === null &&
			![undefined, "acquiring"].includes(current.lifecycle)) ||
		(live &&
			(tokens.ready === null ||
				!["acquiring", "held", "releasing"].includes(current.lifecycle ?? "")))
	)
		throw new OsStageError("rauc_recovery_unproven");
	if (
		tokens.release !== null &&
		(tokens.ready === null ||
			![undefined, "releasing"].includes(current.lifecycle))
	)
		throw new OsStageError("rauc_recovery_unproven");
	await proof();
	const cleanupBudget = createStageDeadline({
		deadline,
		now: deps.now,
		fence: () => {
			if (!deps.control.held() || deps.producerPresent())
				throw new OsStageError("rauc_recovery_unproven");
		},
	});
	await withinStageDeadline(cleanupBudget, () =>
		deps.drain(record.attemptId, cleanupBudget),
	);
	await deps.sweep();
	const settled = await proof();
	if (!(await deps.pinClean()))
		throw new OsStageError("rauc_recovery_unproven");
	await assertOwner();
	if (live) {
		await proof();
		current = { ...current, lifecycle: "releasing" };
		writeOsStageJob(current, deps.directory);
		await assertOwner();
		writePrivateOsJobFile("release", `${record.attemptId}\n`, deps.directory);
		// ~1 s normal latency (the helper polls every second). Expiry proves
		// nothing and never licenses stopping a live helper.
		const exitDeadline = deps.now() + 10_000;
		for (;;) {
			await assertOwner();
			unit = await deps.inspect(record.attemptId);
			if (
				unit.kind === "terminal" &&
				unit.cleanExit &&
				unit.invocationId === initialInvocation &&
				(await kernelGone()) &&
				(await deps.jobIdle())
			)
				return settleOsStageUnlaunched(current, deps);
			if (deps.now() >= exitDeadline)
				throw new OsStageError("rauc_recovery_unproven");
			await deps.sleep(100);
		}
	}
	await assertOwner();
	unit = await deps.inspect(record.attemptId);
	if (unit.kind === "terminal") {
		if (
			unit.invocationId !== initialInvocation ||
			!(await kernelGone()) ||
			!(await deps.jobIdle())
		)
			throw new OsStageError("rauc_recovery_unproven");
		if (unit.cleanExit) {
			const stop = await deps.run(["systemctl", "stop", OS_STAGE_GUARD_UNIT], {
				timeoutMs: 10_000,
			});
			if (stop.exitCode !== 0)
				throw new OsStageError("rauc_recovery_unproven", { cause: stop });
		}
		await assertOwner();
		unit = await deps.inspect(record.attemptId);
		if (unit.kind === "terminal" && unit.invocationId === initialInvocation) {
			if (!(await kernelGone()) || !(await deps.jobIdle()))
				throw new OsStageError("rauc_recovery_unproven");
			const reset = await deps.run(
				["systemctl", "reset-failed", OS_STAGE_GUARD_UNIT],
				{ timeoutMs: 10_000 },
			);
			if (reset.exitCode !== 0)
				throw new OsStageError("rauc_recovery_unproven", { cause: reset });
		}
	}
	if ((await deps.inspect(record.attemptId)).kind !== "absent")
		throw new OsStageError("rauc_recovery_unproven");
	await assertOwner();
	if (!(await kernelGone()) || !(await deps.pinClean()))
		throw new OsStageError("rauc_recovery_unproven");
	deps.witness({
		attemptId: record.attemptId,
		manifestJson: record.candidateKey,
		bootId: settled.bootId,
		baselineInstance: record.baseline.instance,
		...(record.receiptBaseline !== undefined
			? { receiptBaseline: record.receiptBaseline }
			: {}),
	});
	await assertOwner();
	await retireOsStageJob(deps.directory);
}
