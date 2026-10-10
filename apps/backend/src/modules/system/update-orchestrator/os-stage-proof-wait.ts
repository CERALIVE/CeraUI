import { logger } from "../../../helpers/logger.ts";
import {
	describeObservationFailure,
	type ObservationReport,
} from "./os-stage-admission-diagnostics.ts";
import { withinStageDeadline } from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import { stageEvidence } from "./os-stage-process-evidence.ts";
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

export function reportStageProofDecision(input: {
	readonly snapshot: RaucStageSnapshot | null;
	readonly wait: Pick<StageProofWait, "deadline" | "now" | "previousInstance">;
	readonly reason: string;
	readonly disposition: "defer" | "final" | "proven";
	readonly observation?: string;
}): void {
	try {
		const detail = stageEvidence(input.snapshot);
		logger.warn("update-orchestrator: OS stage proof decision", {
			...detail,
			members: detail?.members.slice(0, 16),
			extraMembers: detail?.members
				.filter((member) => member.identity !== input.snapshot?.instance)
				.slice(0, 16),
			resources: input.snapshot?.resources
				.slice(0, 16)
				.map((id) => id.slice(0, 160)),
			currentInstance: input.snapshot?.instance ?? null,
			previousInstance: input.wait.previousInstance ?? null,
			deadlineRemainingMs: Math.max(0, input.wait.deadline - input.wait.now()),
			reason: input.reason,
			disposition: input.disposition,
			observation: input.observation,
		});
	} catch {
		return;
	}
}

export async function waitForStageProof(input: {
	readonly observe: (
		report: ObservationReport,
	) => Promise<RaucStageSnapshot | null>;
	readonly refusal: (
		snapshot: RaucStageSnapshot | null,
	) => Promise<string | null>;
	readonly retryable: (reason: string) => boolean;
	readonly finalRefusal?: (snapshot: RaucStageSnapshot) => string | null;
	readonly requiresFinalRead?: boolean;
	readonly wait: StageProofWait;
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
	const guarded = async <T>(
		boundary: "observation" | "quiescence",
		work: () => Promise<T>,
	): Promise<T> => {
		try {
			return await withinStageDeadline(wait, work);
		} catch (error) {
			if (
				error instanceof OsStageError &&
				error.diagnostics.refusal === "deadline-expired" &&
				input.failure
			)
				throw input.failure(snapshot, "deadline-expired", observation);
			reportStageProofDecision({
				snapshot,
				wait,
				reason: `${boundary}-thrown`,
				disposition: "final",
				observation: describeObservationFailure(boundary, error),
			});
			throw error;
		}
	};
	const assertAuthority = async () => {
		try {
			await withinStageDeadline(wait, wait.assert);
		} catch (error) {
			if (
				error instanceof OsStageError &&
				error.diagnostics.refusal === "deadline-expired" &&
				input.failure
			)
				throw input.failure(snapshot, "deadline-expired", observation);
			reportStageProofDecision({
				snapshot,
				wait,
				reason: "authority-refused",
				disposition: "final",
			});
			throw error;
		}
	};
	while (wait.now() < wait.deadline) {
		await assertAuthority();
		if (input.finalRefusal && !input.requiresFinalRead) await assertAuthority();
		if (wait.now() >= wait.deadline) break;
		observation = undefined;
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
				snapshot = await guarded("observation", () =>
					input.observe(() => undefined),
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
					if (!input.retryable(reason)) break;
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
		if (!input.retryable(reason)) break;
		first ??= snapshot;
		if (!deferred) {
			deferred = true;
			wait.deferred?.();
			if (wait.logEpisode?.() !== false)
				reportStageProofDecision({
					snapshot,
					wait,
					reason,
					disposition: "defer",
					...(observation ? { observation } : {}),
				});
		}
		await guarded("quiescence", () =>
			wait.sleep(Math.min(100, Math.max(0, wait.deadline - wait.now()))),
		);
	}
	reportStageProofDecision({
		snapshot,
		wait,
		reason,
		disposition: "final",
		...(observation ? { observation } : {}),
	});
	throw (
		input.failure?.(snapshot, reason, observation) ??
		new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: reason, ...(observation ? { observation } : {}) },
		})
	);
}
