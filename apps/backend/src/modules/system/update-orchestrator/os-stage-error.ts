// Typed vocabulary for an OS staging (RAUC) failure: the reason, the recovery
// disposition the orchestrator must apply, and the diagnostic context.

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
>;

export class OsStageError extends Error {
	override readonly name = "OsStageError";
	readonly reason: OsStageFailureReason;
	readonly mode: OsStageRecoveryMode;
	readonly diagnostics: OsStageDiagnostics;

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
		this.diagnostics = options?.diagnostics ?? {};
	}
}

export function isOsStageError(error: unknown): error is OsStageError {
	return error instanceof OsStageError;
}
