import { logger } from "../../../helpers/logger.ts";
import { SpawnTimeoutError } from "../../../helpers/spawn-policy.ts";
import type { RankedTransport } from "../update-transport/core.ts";
import type { OsStageControl } from "./os-stage-attempt.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { createOsStageJobOwner } from "./os-stage-job.ts";
import { retainUnsafeOsStagePin } from "./os-stage-pin-retention.ts";
import {
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
	readonly confirmed: (snapshot: RaucStageSnapshot) => void;
	readonly unsafe: (error: OsStageError) => void;
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
		clearInterval(timer);
		input.invalidate();
		requireNewInstance = outcome.kind === "failed";
		if (outcome.kind === "failed")
			logger.warn("update-orchestrator: OS attempt recovery requested", {
				attemptId: control.attemptId,
				pair: `${input.transport.candidate.ifname}/${input.transport.family}`,
				oldInstance: before.instance,
				reason: outcome.error.reason,
				diagnostics: outcome.error.diagnostics,
			});
		owner.remember(before, true, attempt.cliSettled(), requireNewInstance);
		if (requireNewInstance && !control.signal.aborted) await deps.restart();
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
				lockHeld: owner.held,
			},
			requireNewInstance,
		);
		input.confirmed(quiescent);
		owner.remember(quiescent, true, true, requireNewInstance);
		await attempt.cli;
		logger.info("update-orchestrator: OS attempt settled", {
			attemptId: control.attemptId,
			pair: `${input.transport.candidate.ifname}/${input.transport.family}`,
			oldInstance: before.instance,
			currentInstance: quiescent.instance,
			outcome: outcome.kind,
		});
		await input.admit();
		if (observationError)
			throw new OsStageError("rauc_recovery_unproven", {
				cause: observationError,
			});
		if (outcome.kind === "failed") {
			if (outcome.transfer) throw outcome.transfer;
			throw outcome.error;
		}
	} catch (cause) {
		if (quiescent) throw cause;
		const record = owner.record();
		const error =
			cause instanceof OsStageError && cause.mode === "unsafe"
				? cause
				: new OsStageError("rauc_recovery_unproven", { cause });
		return await retainUnsafeOsStagePin({
			attemptId: control.attemptId,
			error,
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
