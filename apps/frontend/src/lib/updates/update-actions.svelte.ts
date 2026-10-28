/**
 * The Updates dialog's operator actions (check, install, cellular approval,
 * and the legacy Packages Update): a thin rune shell around the pure machine
 * in `update-action-outcome.ts`, which decides every outcome.
 *
 * The shell owns only what is asynchronous: it gives each dispatched request a
 * call id, turns the awaited chain into a `conclude`, and starts the details
 * read that follows a concluded call of the current session. A click made
 * while the action's chain is still on the wire is dropped before anything is
 * touched, so a duplicate never owns, clears or concludes another call's
 * outcome (round-2 review C, m1).
 */

import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateState,
} from "@ceraui/rpc/schemas";
import { osCommand } from "$lib/rpc/async-operation.svelte";
import { RPC_CALL_TIMEOUT_MS } from "$lib/rpc/rpc-timeouts";
import { type ActionStep, runSteps } from "./update-action-failure";
import {
	type ActionBand,
	type ActionEvent,
	type ActionOutcome,
	actionBands,
	type DispatchContext,
	INITIAL_ACTIONS,
	isBusy,
	reduceActions,
	type UpdateActionKind,
} from "./update-action-outcome";

export type { UpdateActionKind } from "./update-action-outcome";

export const UPDATE_CHECK_NOW_OP = "update-check-now";
export const UPDATE_INSTALL_NOW_OP = "update-install-now";
export const UPDATE_CELLULAR_OP = "update-cellular-approve";
/** The legacy start keeps its historical key: the dialog's spinner reads it. */
export const UPDATE_PACKAGES_OP = "update";

const ACTION_OPS: Readonly<Record<UpdateActionKind, string>> = {
	check: UPDATE_CHECK_NOW_OP,
	install: UPDATE_INSTALL_NOW_OP,
	kernel: "update-kernel-install",
	cellular: UPDATE_CELLULAR_OP,
	packages: UPDATE_PACKAGES_OP,
};

/**
 * The store's own pending valve, sized to the whole chain: every step can wait
 * one client timeout, and the client always ends each wait, so the busy state
 * can never outlive the chain (m2).
 */
const PENDING_MARGIN_MS = 5_000;

export interface ActionRefusal {
	readonly action: UpdateActionKind;
	readonly reason: string | undefined;
	readonly retryable?: boolean;
}

/** What the actions read from the surface that owns the device reads. */
export interface ActionEvidenceSource {
	dispatchContext(): DispatchContext;
	reloadDetails(): Promise<void>;
}

export interface UpdateActions {
	readonly bands: readonly ActionBand[];
	/** The newest device refusal on screen. */
	readonly refusal: ActionRefusal | undefined;
	/** The newest action whose outcome is on screen as not confirmed. */
	readonly unconfirmed: UpdateActionKind | undefined;
	pending(action: UpdateActionKind): boolean;
	/** The current session's outcome of `action`, whatever its state. */
	outcomeOf(action: UpdateActionKind): ActionOutcome | undefined;
	run(action: UpdateActionKind, steps: readonly ActionStep[]): Promise<void>;
	observePhase(phase: UpdateOrchestratorPhase): void;
	/** The legacy `update_state` kind as pushed; only a CHANGE is evidence. */
	observeLegacy(kind: UpdateState["kind"] | undefined): void;
	/** A details read that landed; `seq` orders it against each dispatch. */
	observeRead(seq: number, details: UpdateDetails): void;
	reset(): void;
}

export function createUpdateActions(
	source: ActionEvidenceSource,
): UpdateActions {
	let machine = $state.raw(INITIAL_ACTIONS);
	let calls = 0;
	let legacy: UpdateState["kind"] | undefined;
	const apply = (event: ActionEvent): void => {
		machine = reduceActions(machine, event);
	};

	async function run(
		action: UpdateActionKind,
		steps: readonly ActionStep[],
	): Promise<void> {
		if (isBusy(machine, action)) return;
		const call = ++calls;
		let session: number | undefined;
		// The legacy start stays pending after an accepted reply until progress
		// confirms it, on the historical valve: that lapse is what the Packages
		// section reports as "accepted, no progress reported".
		const legacyStart = action === "packages";
		const verdict = await osCommand({
			key: ACTION_OPS[action],
			...(legacyStart
				? {}
				: {
						pendingTtlMs:
							steps.length * RPC_CALL_TIMEOUT_MS + PENDING_MARGIN_MS,
					}),
			rpc: () => {
				session = machine.session;
				apply({
					type: "dispatch",
					action,
					call,
					context: source.dispatchContext(),
				});
				return runSteps(steps);
			},
			classify: (result) => ({
				ok: result.kind === "accepted",
				reason: result.kind,
			}),
			confirmOnResolve: !legacyStart,
			silent: true,
		});
		if (session === undefined) return;
		apply({
			type: "conclude",
			call,
			verdict: verdict ?? { kind: "uncertain", cause: "lost" },
		});
		if (session === machine.session) await source.reloadDetails();
	}

	return {
		get bands() {
			return actionBands(machine);
		},
		get refusal() {
			const band = actionBands(machine).findLast(
				(entry) => entry.state === "refused",
			);
			if (band?.state !== "refused") return undefined;
			return {
				action: band.action,
				reason: band.reason,
				...(band.retryable !== undefined ? { retryable: band.retryable } : {}),
			};
		},
		get unconfirmed() {
			return actionBands(machine).findLast(
				(entry) => entry.state === "unconfirmed",
			)?.action;
		},
		pending: (action) => isBusy(machine, action),
		outcomeOf: (action) =>
			machine.outcomes.find((outcome) => outcome.action === action),
		run,
		observePhase: (phase) => apply({ type: "phase", phase }),
		observeLegacy(kind) {
			if (kind === undefined || kind === legacy) return;
			legacy = kind;
			apply({ type: "legacy", kind });
		},
		observeRead: (seq, details) => apply({ type: "read", seq, details }),
		reset: () => apply({ type: "reset" }),
	};
}
