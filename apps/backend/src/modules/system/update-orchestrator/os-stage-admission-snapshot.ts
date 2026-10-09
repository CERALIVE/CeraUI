import { logger } from "../../../helpers/logger.ts";
import {
	failedAdmissionPredicate,
	type ObservationReport,
} from "./os-stage-admission-diagnostics.ts";
import { OsStageError } from "./os-stage-error.ts";
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

/** Observes once and admits it, carrying the observer's own stop reason. */
export async function observeAdmission(
	observe: (report: ObservationReport) => Promise<RaucStageSnapshot | null>,
	baseline?: RaucStageSnapshot,
): Promise<RaucStageSnapshot> {
	let observation: string | undefined;
	const snapshot = await observe((detail) => {
		observation ??= detail;
	});
	return requireAdmissionSnapshot(snapshot, baseline, observation);
}
