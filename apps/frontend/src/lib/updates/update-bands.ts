/**
 * The two update bands that live OUTSIDE the Updates dialog's own sections
 * (Todo 41): the Go-Live refusal band on the Live destination, and the
 * credentials band at the top of the dialog. Pure and rune-free, like
 * `update-view.ts`, which supplies the phase rules both of them lean on.
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
	/** `undefined` only when a refusal from an older backend named no phase. */
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
 * Whether the stream-start surface must say that an update owns the device.
 *
 * The pushed orchestrator state wins whenever it exists: it is fresher than any
 * refusal, and once it has moved past `committing`/`restarting-services` the
 * start the operator was refused is admissible again, so the band must go away
 * even though the refusal it came from is still the last failure on record.
 * Only a backend that publishes no orchestrator state falls back to the typed
 * `update_in_progress` refusal and the progress it carried.
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
 * The update server refused this device's client certificate on the last
 * transport selection. This is the ONLY credential fact on the wire: nothing
 * publishes the certificate's expiry date, so the dialog states a rejection it
 * observed and never a countdown it would have to invent.
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
