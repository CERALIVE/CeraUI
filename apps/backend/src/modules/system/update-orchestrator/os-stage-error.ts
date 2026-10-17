// Typed vocabulary for an OS staging (RAUC) failure: the reason, the recovery
// disposition the orchestrator must apply, and the diagnostic context.
import {
	inheritStageFailure,
	type OsStageFailureStep,
	stageFailureContext,
} from "./os-stage-failure-context.ts";

export const OS_STAGE_FAILURE_REASONS = [
	"os_transport_failed",
	"os_origin_unavailable",
	"os_update_lock_held",
	"os_cellular_approval_required",
	"os_stage_cancelled_for_stream",
	"rauc_install_failed",
	"rauc_recovery_unproven",
	"os_stage_outcome_unknown_after_restart",
] as const;

export type OsStageFailureReason = (typeof OS_STAGE_FAILURE_REASONS)[number];

export type OsStageRecoveryMode =
	| "automatic"
	| "operator"
	| "unsafe"
	| "cancelled";

export const OS_STAGE_FAILURE_MODE: Readonly<
	Record<OsStageFailureReason, OsStageRecoveryMode>
> = {
	os_transport_failed: "automatic",
	os_origin_unavailable: "automatic",
	os_update_lock_held: "automatic",
	os_cellular_approval_required: "operator",
	os_stage_cancelled_for_stream: "cancelled",
	rauc_install_failed: "operator",
	rauc_recovery_unproven: "unsafe",
	os_stage_outcome_unknown_after_restart: "unsafe",
};

export type OsStageDiagnostics = Readonly<
	Record<string, string | number | boolean | null>
> & {
	readonly firstFailureStep?: OsStageFailureStep;
	readonly failureStep?: OsStageFailureStep;
};

export class OsStageError extends Error {
	override readonly name = "OsStageError";
	readonly reason: OsStageFailureReason;
	readonly mode: OsStageRecoveryMode;
	private readonly context: OsStageDiagnostics;
	get diagnostics(): OsStageDiagnostics {
		try {
			const failure = stageFailureContext(this);
			return failure ? { ...this.context, ...failure } : this.context;
		} catch {
			return {};
		}
	}

	constructor(
		reason: OsStageFailureReason,
		options?: {
			readonly cause?: unknown;
			readonly diagnostics?: OsStageDiagnostics;
		},
	) {
		super(reason, { cause: options?.cause });
		this.reason = reason;
		this.mode = OS_STAGE_FAILURE_MODE[reason];
		// A wrapper without its own context keeps the cause's, so a refusal's
		// predicate survives the runner's unsafe re-classification.
		this.context = safeDiagnostics(options);
		if (options?.diagnostics === undefined)
			inheritStageFailure(this, options?.cause);
	}
}

function safeDiagnostics(
	options:
		| { readonly cause?: unknown; readonly diagnostics?: OsStageDiagnostics }
		| undefined,
): OsStageDiagnostics {
	try {
		return (
			options?.diagnostics ??
			(options?.cause instanceof OsStageError ? options.cause.diagnostics : {})
		);
	} catch {
		return {};
	}
}

export function isOsStageError(error: unknown): error is OsStageError {
	return error instanceof OsStageError;
}

export function readStageDiagnostics(error: OsStageError): OsStageDiagnostics {
	try {
		return { ...error.diagnostics };
	} catch {
		return {};
	}
}

export function diagnosticFailureReason(
	error: unknown,
): OsStageFailureReason | "untyped" {
	try {
		return error instanceof OsStageError &&
			OS_STAGE_FAILURE_REASONS.includes(error.reason)
			? error.reason
			: "untyped";
	} catch {
		return "untyped";
	}
}
