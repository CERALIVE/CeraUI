/**
 * Relay endpoint validate-state reducer (Task 14).
 *
 * The backend `relay.validate` RPC walks ordered stages and returns the first
 * failure, or `{ valid: true, stage: "probe" }` on success:
 *
 *   input → protocol → endpoint → dns → probe   (+ "ok" terminal in the UI)
 *
 * This module is the pure, rune-free core that ServerDialog's manual path uses
 * to (a) gate the Save button on the validation lifecycle and (b) project the
 * single RPC result onto the full stage sequence for the multi-stage chip
 * display. Keeping it pure makes it node-testable without jsdom/flushSync
 * (mirrors hud-clock-gating / display-profile).
 */
import {
	RELAY_VALIDATE_STAGES,
	type RelayValidateOutput,
	type RelayValidateStage,
} from "@ceraui/rpc/schemas";

/** Lifecycle of a manual-endpoint validation attempt. */
export type ValidationState = "idle" | "validating" | "pass" | "fail";

export interface Validation {
	state: ValidationState;
	/** Reached stage on pass; failing stage on fail. */
	stage?: RelayValidateStage;
	/** Human-readable failure reason (fail only). */
	reason?: string;
}

/** Per-stage display status for the multi-stage chip row. */
export type StageStatus = "pending" | "active" | "done" | "failed";

export interface StageView {
	stage: RelayValidateStage;
	status: StageStatus;
}

/**
 * True when the current validation state must block Save: a result is in flight
 * (validating) or the last result was invalid (fail). A passing or never-run
 * (idle) validation does not block — idle keeps validation advisory so the
 * operator can still save a plain addr/port without a round-trip.
 */
export function validationBlocksSave(validation: Validation): boolean {
	return validation.state === "validating" || validation.state === "fail";
}

/**
 * Save-enable predicate for the manual endpoint path. Save is enabled only when
 * not streaming, the validation state does not block, and the address/port are
 * non-empty and in range (port-range checked upstream via ValidationAdapter).
 */
export function manualSaveEnabled(params: {
	isStreaming: boolean;
	addr: string;
	portStr: string;
	hasPortError: boolean;
	validation: Validation;
}): boolean {
	if (params.isStreaming) return false;
	if (validationBlocksSave(params.validation)) return false;
	return (
		params.addr.trim() !== "" &&
		params.portStr.trim() !== "" &&
		!params.hasPortError
	);
}

/** Map a successful/failed RPC result onto the validation state. */
export function reduceValidateResult(result: RelayValidateOutput): Validation {
	return result.valid
		? { state: "pass", stage: result.stage }
		: { state: "fail", stage: result.stage, reason: result.reason };
}

/**
 * Map a thrown error (transport/RPC failure) onto a fail at the `endpoint`
 * stage — the last stage the client can attribute a generic failure to without
 * a structured backend response.
 */
export function reduceValidateError(error: unknown): Validation {
	return error instanceof Error
		? { state: "fail", stage: "endpoint", reason: error.message }
		: { state: "fail", stage: "endpoint" };
}

/**
 * Project a single validation state onto the full ordered stage sequence for
 * the multi-stage chip row:
 *
 *   • idle       → every stage pending
 *   • validating → every stage active (the in-flight spinner state)
 *   • pass       → every stage done (reached the terminal `ok`)
 *   • fail @ X   → stages before X done, X failed, stages after X pending
 */
export function deriveStageViews(validation: Validation): StageView[] {
	const stages = RELAY_VALIDATE_STAGES;
	if (validation.state === "idle")
		return stages.map((stage) => ({ stage, status: "pending" }));
	if (validation.state === "validating")
		return stages.map((stage) => ({ stage, status: "active" }));
	if (validation.state === "pass")
		return stages.map((stage) => ({ stage, status: "done" }));

	const failIdx = validation.stage ? stages.indexOf(validation.stage) : 0;
	return stages.map((stage, index) => ({
		stage,
		status: index < failIdx ? "done" : index === failIdx ? "failed" : "pending",
	}));
}
