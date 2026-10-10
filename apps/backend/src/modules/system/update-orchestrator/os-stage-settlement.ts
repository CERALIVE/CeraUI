import { logger } from "../../../helpers/logger.ts";
import { SpawnTimeoutError } from "../../../helpers/spawn-policy.ts";
import type { RankedTransport } from "../update-transport/core.ts";
import type { OsStageControl } from "./os-stage-attempt.ts";
import { withinStageDeadline } from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { createOsStageJobOwner } from "./os-stage-job.ts";
import { OsStageUnpublishedSuccessError } from "./os-stage-outcome-error.ts";
import { retainUnsafeOsStagePin } from "./os-stage-pin-retention.ts";
import {
	RAUC_RECOVERY_DEADLINE_MS,
	type RaucStageSnapshot,
	recoverRaucStage,
} from "./os-stage-recovery.ts";
import type { OsStageRunDeps } from "./os-stage-run.ts";

type AttemptSettlement = {
	readonly url: string;
	readonly transport: RankedTransport;
	readonly control: OsStageControl;
	readonly before: RaucStageSnapshot;
	readonly owner: ReturnType<typeof createOsStageJobOwner>;
	readonly deps: Pick<
		OsStageRunDeps<unknown>,
		"attempt" | "now" | "sleep" | "restart" | "readProgress" | "progress"
	>;
	readonly admit: () => Promise<void>;
	readonly capture: () => Promise<RaucStageSnapshot | null>;
	readonly generation: () => number;
	readonly invalidate: () => number;
	readonly confirmed: (snapshot: RaucStageSnapshot, deadline: number) => void;
	readonly unsafe: (error: OsStageError) => void;
	readonly successful?: () => void;
	readonly drain: Promise<void>;
};

export async function settlePinnedOsAttempt(
	input: AttemptSettlement,
): Promise<void> {
	const { before, owner, control, deps } = input;
	const generation = input.invalidate();
	const attempt = deps.attempt({
		url: input.url,
		transport: input.transport,
		control,
	});
	void attempt.cli.then((result) => {
		logger.info("update-orchestrator: OS install client settled", {
			attemptId: control.attemptId,
			pair: `${input.transport.candidate.ifname}/${input.transport.family}`,
			oldInstance: before.instance,
			exitCode: result instanceof Error ? null : result.exitCode,
			stdout:
				result instanceof SpawnTimeoutError
					? result.partialStdout
					: result instanceof Error
						? ""
						: result.stdout,
			stderr:
				result instanceof SpawnTimeoutError
					? result.partialStderr
					: result instanceof Error
						? result.message
						: result.stderr,
		});
	});
	let observing = false;
	let observationError: unknown;
	let quiescent: RaucStageSnapshot | null = null;
	let requireNewInstance = true;
	const timer = setInterval(() => {
		if (observing) return;
		observing = true;
		void input
			.capture()
			.then(async () => {
				const percent = await deps.readProgress();
				if (
					generation === input.generation() &&
					!control.signal.aborted &&
					percent !== null
				)
					deps.progress(percent);
			})
			.catch((error: unknown) => {
				observationError = error;
			})
			.finally(() => {
				observing = false;
			});
	}, 3_000);
	timer.unref();
	try {
		const outcome = await attempt.outcome;
		const deadline = deps.now() + RAUC_RECOVERY_DEADLINE_MS;
		clearInterval(timer);
		input.invalidate();
		requireNewInstance = outcome.kind === "failed";
		if (outcome.kind === "failed")
			logger.warn("update-orchestrator: OS attempt recovery requested", {
				attemptId: control.attemptId,
				pair: `${input.transport.candidate.ifname}/${input.transport.family}`,
				oldInstance: before.instance,
				recoveryStartedMs: deps.now(),
				recoveryDeadlineMs: deadline,
				reason: outcome.error.reason,
				diagnostics: outcome.error.diagnostics,
			});
		owner.remember(before, true, attempt.cliSettled(), requireNewInstance);
		if (requireNewInstance && !control.signal.aborted) await deps.restart();
		const cliResult = await withinStageDeadline(
			{
				deadline,
				now: deps.now,
				invalidate: () => {
					input.invalidate();
				},
			},
			() => attempt.cli,
		);
		if (
			!(cliResult instanceof Error) &&
			cliResult.exitCode === 0 &&
			(outcome.kind === "succeeded" || attempt.cliSucceeded?.())
		) {
			requireNewInstance = false;
			input.successful?.();
			owner.remember(before, true, true, false);
		}
		const record = owner.record();
		quiescent = await recoverRaucStage(
			{
				baseline: before,
				processes: new Set(record.processes),
				resources: new Set(record.resources),
			},
			{
				now: deps.now,
				sleep: deps.sleep,
				observe: input.capture,
				cliSettled: attempt.cliSettled,
				lockHeld: async () => {
					await owner.assertAuthority?.();
					return owner.held();
				},
				deadline,
				invalidate: () => {
					input.invalidate();
				},
			},
			requireNewInstance,
		);
		input.confirmed(quiescent, deadline);
		owner.remember(quiescent, true, true, requireNewInstance);
		await attempt.cli;
		logger.info("update-orchestrator: OS attempt settled", {
			attemptId: control.attemptId,
			pair: `${input.transport.candidate.ifname}/${input.transport.family}`,
			oldInstance: before.instance,
			currentInstance: quiescent.instance,
			recoveryDeadlineMs: deadline,
			deadlineRemainingMs: Math.max(0, deadline - deps.now()),
			outcome: outcome.kind,
		});
		await input.admit();
		if (observationError)
			throw new OsStageError("rauc_recovery_unproven", {
				cause: observationError,
			});
		if (outcome.kind === "failed") {
			if (attempt.cliSucceeded?.())
				throw new OsStageUnpublishedSuccessError(outcome.error);
			if (outcome.transfer) throw outcome.transfer;
			throw outcome.error;
		}
	} catch (cause) {
		if (attempt.cliSucceeded?.()) input.successful?.();
		if (quiescent) throw cause;
		const record = owner.record();
		const error =
			cause instanceof OsStageError && cause.mode === "unsafe"
				? cause
				: new OsStageError("rauc_recovery_unproven", { cause });
		return await retainUnsafeOsStagePin({
			attemptId: control.attemptId,
			error: attempt.cliSucceeded?.()
				? new OsStageError("rauc_recovery_unproven", {
						cause: new OsStageUnpublishedSuccessError(error),
					})
				: error,
			ownership: {
				baseline: before,
				processes: new Set(record.processes),
				resources: new Set(record.resources),
			},
			observe: input.capture,
			cliSettled: attempt.cliSettled,
			lockHeld: owner.held,
			requireNewInstance,
			notify: input.unsafe,
			drain: input.drain,
		});
	} finally {
		input.invalidate();
		clearInterval(timer);
		attempt.dispose();
	}
}
