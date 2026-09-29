/**
 * The two update bands that live OUTSIDE the Updates dialog's own sections
 * (Todo 41): the Go-Live refusal band and the credentials band.
 */
import type {
	StartFailure,
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";

import {
	etaMinutes,
	isUpdateRefusingStart,
	progressPercent,
} from "./update-view";

export interface GoLiveUpdateRefusal {
	readonly phase: UpdateOrchestratorPhase | undefined;
	readonly percent: number | undefined;
	readonly etaMinutes: number | undefined;
	/** `live` = the pushed orchestrator state; `refusal` = the last start's answer. */
	readonly source: "live" | "refusal";
}

function wholePercent(percent: number | undefined): number | undefined {
	if (percent === undefined || !Number.isFinite(percent)) return undefined;
	return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Prefer pushed state so an old refusal does not leave a stale band. This is
 * display precedence, not proof a start is admissible (root AGENTS.md D8 Known gaps).
 */
export function goLiveUpdateRefusal(
	wire: UpdateOrchestratorWireState | undefined | null,
	failure: StartFailure | undefined | null,
): GoLiveUpdateRefusal | undefined {
	if (wire !== undefined && wire !== null) {
		if (!isUpdateRefusingStart(wire)) return undefined;
		return {
			phase: wire.phase,
			percent: progressPercent(wire),
			etaMinutes: etaMinutes(wire.progress?.etaSeconds),
			source: "live",
		};
	}
	if (failure?.class !== "update_in_progress") return undefined;
	return {
		phase: failure.updatePhase,
		percent: wholePercent(failure.updatePercent),
		etaMinutes: etaMinutes(failure.updateEtaSeconds),
		source: "refusal",
	};
}

/**
 * State a reported rejection rather than inventing a certificate-expiry date.
 */
export function transportCredentialsRejected(
	details: UpdateDetails | undefined,
): boolean {
	return (
		details?.transport?.findings.some((finding) =>
			finding.states.includes("credentials-invalid"),
		) ?? false
	);
}
