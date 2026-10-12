/**
 * The Updates dialog's action/outcome machine. Pure; the contract is
 * `docs/agents/an-update-action-outcome-is-decided-by-evidence.md`.
 *
 * Every dispatched request is ONE call with its own id. A call is `dispatched`
 * until its awaited chain settles, then `accepted`, `refused` ("Not started"),
 * or `unconfirmed`; device evidence observed AFTER the dispatch (a changed
 * phase, a details read that started later and landed) folds into its watch
 * and turns `unconfirmed` into `reconciled`. Only the call that owns an
 * outcome may conclude it; a closed dialog (`reset`) keeps nothing but the
 * busy marks of chains still on the wire.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";

import type { ActionVerdict, UncertainCause } from "./update-action-failure";
import {
	type DispatchContext,
	phaseSettles,
	readSettles,
	type UpdateActionKind,
} from "./update-action-settlement";

export type {
	DispatchContext,
	UpdateActionKind,
} from "./update-action-settlement";

export interface ActionWatch extends DispatchContext {
	/** Sticky: the device has shown what became of the request. */
	readonly settled: boolean;
}

interface Owned {
	readonly action: UpdateActionKind;
	readonly call: number;
}

export type ActionOutcome =
	| (Owned & { readonly state: "dispatched"; readonly watch: ActionWatch })
	| (Owned & { readonly state: "accepted" | "reconciled" })
	| (Owned & {
			readonly state: "refused";
			readonly reason: string | undefined;
			readonly retryable?: boolean;
	  })
	| (Owned & {
			readonly state: "unconfirmed";
			readonly cause: UncertainCause;
			readonly watch: ActionWatch;
	  });

interface InFlight extends Owned {
	readonly session: number;
}

export interface ActionMachine {
	readonly session: number;
	/** This session's outcomes: at most one per action, in dispatch order. */
	readonly outcomes: readonly ActionOutcome[];
	/** Calls whose chain has not settled, from ANY session: the busy state. */
	readonly inFlight: readonly InFlight[];
}

export type ActionEvent =
	| {
			readonly type: "dispatch";
			readonly action: UpdateActionKind;
			readonly call: number;
			readonly context: DispatchContext;
	  }
	| {
			readonly type: "conclude";
			readonly call: number;
			readonly verdict: ActionVerdict;
	  }
	| { readonly type: "phase"; readonly phase: UpdateOrchestratorPhase }
	| {
			readonly type: "read";
			readonly seq: number;
			readonly details: UpdateDetails;
	  }
	| { readonly type: "reset" };

export const INITIAL_ACTIONS: ActionMachine = {
	session: 0,
	outcomes: [],
	inFlight: [],
};

export function isBusy(
	machine: ActionMachine,
	action: UpdateActionKind,
): boolean {
	return machine.inFlight.some((call) => call.action === action);
}

function evidenceSettles(
	outcome: Owned,
	watch: ActionWatch,
	event: Extract<ActionEvent, { type: "phase" | "read" }>,
): boolean {
	if (event.type === "phase") return phaseSettles(outcome.action, event.phase);
	return (
		event.seq > watch.afterRead &&
		readSettles(outcome.action, watch, event.details)
	);
}

function fold(
	outcome: ActionOutcome,
	event: Extract<ActionEvent, { type: "phase" | "read" }>,
): ActionOutcome {
	if (outcome.state !== "dispatched" && outcome.state !== "unconfirmed")
		return outcome;
	if (outcome.watch.settled || !evidenceSettles(outcome, outcome.watch, event))
		return outcome;
	if (outcome.state === "unconfirmed")
		return { action: outcome.action, call: outcome.call, state: "reconciled" };
	return { ...outcome, watch: { ...outcome.watch, settled: true } };
}

function concluded(
	outcome: Extract<ActionOutcome, { state: "dispatched" }>,
	verdict: ActionVerdict,
): ActionOutcome {
	const owner = { action: outcome.action, call: outcome.call };
	switch (verdict.kind) {
		case "accepted":
			return { ...owner, state: "accepted" };
		case "refused":
			return {
				...owner,
				state: "refused",
				reason: verdict.reason,
				...(verdict.retryable !== undefined
					? { retryable: verdict.retryable }
					: {}),
			};
		case "uncertain":
			return outcome.watch.settled
				? { ...owner, state: "reconciled" }
				: {
						...owner,
						state: "unconfirmed",
						cause: verdict.cause,
						watch: outcome.watch,
					};
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
}

function conclude(
	machine: ActionMachine,
	call: number,
	verdict: ActionVerdict,
): ActionMachine {
	const flight = machine.inFlight.find((entry) => entry.call === call);
	if (flight === undefined) return machine;
	const inFlight = machine.inFlight.filter((entry) => entry !== flight);
	if (flight.session !== machine.session) return { ...machine, inFlight };
	return {
		...machine,
		inFlight,
		outcomes: machine.outcomes.map((outcome) =>
			outcome.call === call && outcome.state === "dispatched"
				? concluded(outcome, verdict)
				: outcome,
		),
	};
}

export function reduceActions(
	machine: ActionMachine,
	event: ActionEvent,
): ActionMachine {
	switch (event.type) {
		case "dispatch": {
			if (isBusy(machine, event.action)) return machine;
			const owner = { action: event.action, call: event.call };
			return {
				...machine,
				inFlight: [...machine.inFlight, { ...owner, session: machine.session }],
				outcomes: [
					...machine.outcomes.filter(
						(outcome) => outcome.action !== event.action,
					),
					{
						...owner,
						state: "dispatched",
						watch: { ...event.context, settled: false },
					},
				],
			};
		}
		case "conclude":
			return conclude(machine, event.call, event.verdict);
		case "phase":
		case "read":
			return {
				...machine,
				outcomes: machine.outcomes.map((outcome) => fold(outcome, event)),
			};
		case "reset":
			return { ...machine, session: machine.session + 1, outcomes: [] };
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** The bands an operator sees: a device refusal, or an outcome nobody knows. */
export type ActionBand = Extract<
	ActionOutcome,
	{ state: "refused" | "unconfirmed" }
>;

export function actionBands(machine: ActionMachine): readonly ActionBand[] {
	return machine.outcomes.filter(
		(outcome): outcome is ActionBand =>
			outcome.state === "refused" || outcome.state === "unconfirmed",
	);
}
