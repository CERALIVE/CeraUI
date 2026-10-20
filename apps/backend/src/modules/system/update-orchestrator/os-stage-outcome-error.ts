import { OsStageError } from "./os-stage-error.ts";

/** Raw cancellation stays compatible; the production entry must adjudicate it unsafe. */
export class OsStageUnpublishedSuccessError extends OsStageError {
	constructor(cause: unknown) {
		super(
			cause instanceof OsStageError &&
				cause.reason === "os_stage_cancelled_for_stream"
				? cause.reason
				: "rauc_recovery_unproven",
			{ cause },
		);
	}
}
