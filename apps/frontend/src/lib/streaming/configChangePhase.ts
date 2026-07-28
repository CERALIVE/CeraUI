import {
	type ConfigChangePhase,
	type ConfigChangeState,
	isTerminalConfigChangePhase,
} from "@ceraui/rpc/schemas";

export type ConfigChangeView =
	| { attemptId: string; phase: ConfigChangePhase; reason?: string }
	| undefined;

/**
 * Fold one `config-change` push onto the rendered view, fencing stale attempts.
 *
 * Two rules, and the SECOND one exists because of a real defect class: a phase
 * can fire before anyone is listening. A client that connects mid-transaction
 * never saw `applying`, so refusing every terminal phase without a known
 * current attempt would silently swallow the only outcome the operator gets.
 * An unknown attempt is therefore ADOPTED; only a terminal phase contradicting
 * a KNOWN current attempt is dropped as stale.
 */
export function reduceConfigChange(
	current: ConfigChangeView,
	incoming: ConfigChangeState,
): ConfigChangeView {
	const next: ConfigChangeView = {
		attemptId: incoming.attemptId,
		phase: incoming.phase,
		...(incoming.reason === undefined ? {} : { reason: incoming.reason }),
	};

	// A fresh `applying` always supersedes — it IS a newer attempt by definition.
	if (!isTerminalConfigChangePhase(incoming.phase)) return next;

	if (current !== undefined && current.attemptId !== incoming.attemptId)
		return current;
	return next;
}

export function isConfigChangeInFlight(view: ConfigChangeView): boolean {
	return view?.phase === "applying";
}
