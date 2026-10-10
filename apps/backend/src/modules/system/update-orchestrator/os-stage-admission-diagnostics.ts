// Diagnostic vocabulary for OS stage admission. It names WHY admission refused;
// it never decides admission on its own and never relaxes a refusal.
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

/** Receives at most one bounded, redacted line naming where observation stopped. */
export type ObservationReport = (detail: string) => void;

const BASELINE_FIELDS = [
	"bootId",
	"bootPrimary",
	"bootedSlot",
	"bootedDevice",
	"targetSlot",
	"targetDevice",
] as const;

export type AdmissionPredicate =
	| "observation-unknown"
	| "daemon-inactive"
	| "operation-not-idle"
	| "resources-present"
	| "extra-process"
	| "booted-unhealthy"
	| "target-not-inactive"
	| "boot-primary-unknown"
	| "boot-primary-not-booted"
	| "boot-primary-is-target"
	| "activation-armed"
	| `baseline-changed:${(typeof BASELINE_FIELDS)[number]}`;

/**
 * The first failing admission predicate, in the evaluation order of the
 * original single condition; null means the snapshot is admitted.
 */
export function failedAdmissionPredicate(
	snapshot: RaucStageSnapshot | null,
	baseline?: RaucStageSnapshot,
): AdmissionPredicate | null {
	if (!snapshot) return "observation-unknown";
	if (!snapshot.active) return "daemon-inactive";
	if (snapshot.operation !== "idle") return "operation-not-idle";
	if (snapshot.resources.length) return "resources-present";
	if (snapshot.processes.some((id) => id !== snapshot.instance))
		return "extra-process";
	if (!snapshot.bootedHealthy) return "booted-unhealthy";
	if (!snapshot.targetInactive) return "target-not-inactive";
	if (!snapshot.bootPrimary) return "boot-primary-unknown";
	if (snapshot.bootPrimary !== snapshot.bootedSlot)
		return "boot-primary-not-booted";
	if (snapshot.bootPrimary === snapshot.targetSlot)
		return "boot-primary-is-target";
	if (snapshot.activationArmed) return "activation-armed";
	if (baseline === undefined) return null;
	const changed = BASELINE_FIELDS.find(
		(field) => snapshot[field] !== baseline[field],
	);
	return changed ? `baseline-changed:${changed}` : null;
}

const MAX_DETAIL = 200;

const ERROR_CLASSES = new Set([
	"Error",
	"TypeError",
	"SyntaxError",
	"RangeError",
	"ZodError",
	"SpawnTimeoutError",
]);
const ERROR_CODES = new Set([
	"ENOENT",
	"EACCES",
	"EPERM",
	"EIO",
	"ENOTDIR",
	"ELOOP",
	"ETIMEDOUT",
	"EROFS",
]);

export function describeObservationFailure(
	stage: string,
	error: unknown,
): string {
	try {
		if (!(error instanceof Error)) return `${stage}: thrown ${typeof error}`;
		const observedName = error.name;
		const name = ERROR_CLASSES.has(observedName) ? observedName : "Error";
		const rawCode = "code" in error ? error.code : undefined;
		const code =
			typeof rawCode === "string" && ERROR_CODES.has(rawCode)
				? `(${rawCode})`
				: "";
		// Messages and arbitrary class/code strings can contain credentials.
		return `${stage}: ${name}${code}:`.slice(0, MAX_DETAIL);
	} catch {
		// Exception properties may themselves throw; diagnostics remain optional.
		return `${stage}: unknown-error`.slice(0, MAX_DETAIL);
	}
}

/** A diagnostic sink can never change the observation's safety result. */
export function notifyObservation(
	report: ObservationReport | undefined,
	detail: string,
): void {
	try {
		report?.(detail.slice(0, MAX_DETAIL));
	} catch {
		// The sink boundary cannot replace the observer's refusal.
		return;
	}
}
