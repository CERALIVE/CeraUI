import { logger } from "../../../helpers/logger.ts";
import {
	failedAdmissionPredicate,
	type ObservationReport,
} from "./os-stage-admission-diagnostics.ts";
import { OsStageError } from "./os-stage-error.ts";
import {
	type StageProofWait,
	waitForStageProof,
} from "./os-stage-proof-wait.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

/**
 * Refuses unless every admission predicate holds. The refusal keeps its
 * unsafe classification; its diagnostics name the first failing predicate and,
 * when observation stopped, where it stopped.
 */
export function requireAdmissionSnapshot(
	snapshot: RaucStageSnapshot | null,
	baseline?: RaucStageSnapshot,
	observation?: string,
): RaucStageSnapshot {
	const predicate = failedAdmissionPredicate(snapshot, baseline);
	if (snapshot && predicate === null) return snapshot;
	const diagnostics = {
		refusal: "stage-admission-unproven",
		predicate: predicate ?? "observation-unknown",
		...(observation === undefined ? {} : { observation }),
	};
	try {
		logger.warn("update-orchestrator: OS stage admission refused", diagnostics);
	} catch {
		// A logging fault must not replace the typed unsafe refusal below.
	}
	throw new OsStageError("rauc_recovery_unproven", { diagnostics });
}

/** The first observation of an attempt tracks nothing it could own yet. */
export const UNTRACKED_OBSERVATION: {
	readonly processes: ReadonlySet<string>;
	readonly resources: ReadonlySet<string>;
} = Object.freeze({
	processes: new Set<string>(),
	resources: new Set<string>(),
});

/** Re-observation never authorizes the extra-member snapshot itself. */
export async function observeAdmission(
	observe: (report: ObservationReport) => Promise<RaucStageSnapshot | null>,
	baseline?: RaucStageSnapshot,
	wait?: StageProofWait & {
		readonly quiescence?: (
			snapshot: RaucStageSnapshot,
		) => Promise<string | null>;
		readonly finalQuiescence?: (snapshot: RaucStageSnapshot) => string | null;
	},
): Promise<RaucStageSnapshot> {
	if (wait) {
		const snapshot = await waitForStageProof({
			observe,
			wait,
			requiresFinalRead: wait.quiescence !== undefined,
			finalRefusal: (current) => {
				const predicate = failedAdmissionPredicate(current, baseline);
				if (predicate === "extra-process") {
					const structural = failedAdmissionPredicate(
						{ ...current, processes: [current.instance] },
						baseline,
					);
					if (structural) return structural;
				}
				return predicate ?? wait.finalQuiescence?.(current) ?? null;
			},
			failure: (current, reason, observation) =>
				new OsStageError("rauc_recovery_unproven", {
					diagnostics: {
						refusal: "stage-admission-unproven",
						predicate:
							reason === "deadline-expired" ||
							reason === "daemon-identity-changed"
								? reason
								: (failedAdmissionPredicate(current, baseline) ?? reason),
						...(observation === undefined ? {} : { observation }),
					},
				}),
			refusal: async (current) => {
				const predicate = failedAdmissionPredicate(current, baseline);
				if (!current) return predicate;
				// Check predicates masked by extras; this projection is NEVER returned.
				if (predicate === "extra-process") {
					const structural = failedAdmissionPredicate(
						{ ...current, processes: [current.instance] },
						baseline,
					);
					if (structural) return structural;
				}
				const quiescence = await wait.quiescence?.(current);
				if (
					quiescence &&
					!["old-installer-survives", "installer-ownership-unproven"].includes(
						quiescence,
					)
				)
					return quiescence;
				return predicate ?? quiescence ?? null;
			},
			retryable: (reason) => reason === "extra-process",
		});
		return requireAdmissionSnapshot(snapshot, baseline);
	}
	let observation: string | undefined;
	const snapshot = await observe((detail) => {
		observation ??= detail;
	});
	return requireAdmissionSnapshot(snapshot, baseline, observation);
}
