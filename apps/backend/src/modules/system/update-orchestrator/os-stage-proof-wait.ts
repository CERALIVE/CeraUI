import {
	describeObservationFailure,
	type ObservationReport,
	STAGE_CENSUS_DRIFT,
} from "./os-stage-admission-diagnostics.ts";
import { raceStageDeadline, withinStageDeadline } from "./os-stage-deadline.ts";
import { OsStageError, readStageDiagnostics } from "./os-stage-error.ts";
import {
	type OsStageFailureStep,
	recordStageFailure,
} from "./os-stage-failure-context.ts";
import { stageEvidence } from "./os-stage-process-evidence.ts";
import { reportStageProofDecision } from "./os-stage-proof-report.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

export type StageProofClock = {
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
};
export type StageProofWait = StageProofClock & {
	readonly deadline: number;
	readonly assert: () => Promise<void>;
	readonly previousInstance?: string;
	readonly deferred?: () => void;
	readonly invalidate?: () => void;
	readonly finalAssert?: () => void;
	readonly logEpisode?: () => boolean;
};

export { reportStageProofDecision } from "./os-stage-proof-report.ts";

export async function waitForStageProof(input: {
	readonly observe: (
		report: ObservationReport,
	) => Promise<RaucStageSnapshot | null>;
	readonly refusal: (
		snapshot: RaucStageSnapshot | null,
	) => Promise<string | null>;
	readonly retryable: (
		reason: string,
		observation: string | undefined,
	) => boolean;
	readonly finalRefusal?: (snapshot: RaucStageSnapshot) => string | null;
	readonly requiresFinalRead?: boolean;
	readonly wait: StageProofWait;
	readonly failureStep?: OsStageFailureStep;
	readonly failure?: (
		snapshot: RaucStageSnapshot | null,
		reason: string,
		observation: string | undefined,
	) => OsStageError;
}): Promise<RaucStageSnapshot> {
	const { wait } = input;
	let deferred = false;
	let first: RaucStageSnapshot | null = null;
	let snapshot: RaucStageSnapshot | null = null;
	let reason = "deadline-expired";
	let observation: string | undefined;
	let attempts = 0;
	let started: number | undefined;
	const clock = () => {
		const now = wait.now();
		started ??= now;
		return now;
	};
	const contextual = (
		error: unknown,
		predicate = reason,
		detail = observation,
	) => {
		try {
			recordStageFailure(error, input.failureStep ?? "settlement-proof", {
				predicate,
				...(detail ? { observation: detail } : {}),
				attempts,
				...(started === undefined
					? {}
					: { elapsedMs: Math.max(0, wait.now() - started) }),
			});
		} catch {
			recordStageFailure(error, "settlement-proof");
		}
		return error;
	};
	const guarded = async <T>(
		boundary: "observation" | "quiescence",
		work: () => Promise<T>,
		settle: typeof withinStageDeadline = withinStageDeadline,
	): Promise<T> => {
		try {
			return await settle(wait, work);
		} catch (error) {
			if (
				error instanceof OsStageError &&
				readStageDiagnostics(error).refusal === "deadline-expired" &&
				input.failure
			)
				throw contextual(
					input.failure(snapshot, "deadline-expired", observation),
					"deadline-expired",
				);
			reportStageProofDecision({
				snapshot,
				wait,
				reason: `${boundary}-thrown`,
				disposition: "final",
				observation: describeObservationFailure(boundary, error),
			});
			throw contextual(
				error,
				`${boundary}-thrown`,
				describeObservationFailure(boundary, error),
			);
		}
	};
	const assertAuthority = async () => {
		try {
			await withinStageDeadline(wait, wait.assert);
		} catch (error) {
			if (
				error instanceof OsStageError &&
				readStageDiagnostics(error).refusal === "deadline-expired" &&
				input.failure
			)
				throw contextual(
					input.failure(snapshot, "deadline-expired", observation),
					"deadline-expired",
				);
			reportStageProofDecision({
				snapshot,
				wait,
				reason: "authority-refused",
				disposition: "final",
			});
			throw contextual(error, "authority-refused");
		}
	};
	while (clock() < wait.deadline) {
		await assertAuthority();
		if (input.finalRefusal && !input.requiresFinalRead) await assertAuthority();
		if (wait.now() >= wait.deadline) break;
		observation = undefined;
		++attempts;
		snapshot = await guarded("observation", () =>
			input.observe((detail) => {
				observation ??= detail;
			}),
		);
		if (input.finalRefusal && !input.requiresFinalRead) {
			wait.finalAssert?.();
			reason = snapshot
				? (input.finalRefusal(snapshot) ?? "proven")
				: "observation-unknown";
		} else {
			await assertAuthority();
			reason =
				(await guarded("quiescence", () => input.refusal(snapshot))) ??
				"proven";
		}
		if (
			first &&
			snapshot &&
			(first.instance !== snapshot.instance ||
				stageEvidence(first)?.invocationId !==
					stageEvidence(snapshot)?.invocationId)
		)
			reason = "daemon-identity-changed";
		if (wait.now() >= wait.deadline) {
			if (reason === "proven") reason = "deadline-expired";
			break;
		}
		if (snapshot && reason === "proven") {
			if (input.finalRefusal && input.requiresFinalRead) {
				observation = undefined;
				++attempts;
				snapshot = await guarded("observation", () =>
					input.observe((detail) => {
						observation ??= detail;
					}),
				);
				wait.finalAssert?.();
				reason = snapshot
					? (input.finalRefusal(snapshot) ?? "proven")
					: "observation-unknown";
				if (
					first &&
					snapshot &&
					(first.instance !== snapshot.instance ||
						stageEvidence(first)?.invocationId !==
							stageEvidence(snapshot)?.invocationId)
				)
					reason = "daemon-identity-changed";
				if (wait.now() >= wait.deadline) reason = "deadline-expired";
				if (!snapshot || reason !== "proven") {
					if (!input.retryable(reason, observation)) break;
				}
			}
			if (snapshot && reason === "proven") {
				if (deferred && wait.logEpisode?.() !== false)
					reportStageProofDecision({
						snapshot,
						wait,
						reason,
						disposition: "proven",
					});
				return snapshot;
			}
		}
		if (!input.retryable(reason, observation)) break;
		first ??= snapshot;
		if (!deferred) {
			deferred = true;
			wait.deferred?.();
			if (observation !== STAGE_CENSUS_DRIFT && wait.logEpisode?.() !== false)
				reportStageProofDecision({
					snapshot,
					wait,
					reason,
					disposition: "defer",
					...(observation ? { observation } : {}),
				});
		}
		// A pause ending at the deadline is the loop's normal, reported exit.
		await guarded(
			"quiescence",
			() => wait.sleep(Math.min(100, Math.max(0, wait.deadline - wait.now()))),
			raceStageDeadline,
		);
	}
	reportStageProofDecision({
		snapshot,
		wait,
		reason,
		disposition: "final",
		...(observation ? { observation } : {}),
	});
	throw contextual(
		input.failure?.(snapshot, reason, observation) ??
			new OsStageError("rauc_recovery_unproven", {
				diagnostics: {
					refusal: reason,
					...(observation ? { observation } : {}),
				},
			}),
	);
}
