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

// Error text can carry device paths, URLs with credentials or key=value secrets.
function redact(text: string): string {
	return text
		.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
		.replace(/(?:\/[^\s'"`,:;)]+)+/g, "<path>")
		.replace(
			/\b(password|passwd|secret|token|key|auth[a-z]*)=\S+/gi,
			"$1=<redacted>",
		);
}

export function describeObservationFailure(
	stage: string,
	error: unknown,
): string {
	if (!(error instanceof Error)) return `${stage}: thrown ${typeof error}`;
	const code =
		"code" in error && typeof error.code === "string" ? `(${error.code})` : "";
	return `${stage}: ${error.name}${code}: ${redact(error.message)}`.slice(
		0,
		MAX_DETAIL,
	);
}

/** A diagnostic sink can never change the observation's safety result. */
export function notifyObservation(
	report: ObservationReport | undefined,
	detail: string,
): void {
	try {
		report?.(detail.slice(0, MAX_DETAIL));
	} catch {
		// Diagnostics are best-effort; the refusal itself is the safety outcome.
	}
}
