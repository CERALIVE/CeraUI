/**
 * The Updates dialog's three operator actions (check, install, cellular
 * approval) and what became of the last one (Todo 41, C-M1).
 *
 * A device answer that declines is a refusal ("Not started"). A reply that
 * never arrived is NOT: the backend answers an OS install only after the stage
 * finishes, long after the browser stops waiting. That outcome stays
 * `unconfirmed` until the device itself settles it, by a pushed phase or by a
 * details read sent after the request (`update-action-outcome.ts`); the
 * surface that owns the reads calls `settle()` after every one of them.
 *
 * `reset()` ends the session: a result that lands afterwards writes nothing
 * and starts no read, so a closed dialog carries nothing into the next open.
 */

import type { UpdateOrchestratorPhase } from "@ceraui/rpc/schemas";
import { getOperationPhase, osCommand } from "$lib/rpc/async-operation.svelte";
import { RPC_CALL_TIMEOUT_MS } from "$lib/rpc/rpc-timeouts";
import { UpdateActionFailure } from "./update-action-failure";
import {
	type ActionEvidence,
	type ActionWatch,
	actionSettled,
	type UpdateActionKind,
	watchAction,
	withPhase,
} from "./update-action-outcome";

export type { UpdateActionKind } from "./update-action-outcome";

export const UPDATE_CHECK_NOW_OP = "update-check-now";
export const UPDATE_INSTALL_NOW_OP = "update-install-now";
export const UPDATE_CELLULAR_OP = "update-cellular-approve";

const ACTION_OPS: Readonly<Record<UpdateActionKind, string>> = {
	check: UPDATE_CHECK_NOW_OP,
	install: UPDATE_INSTALL_NOW_OP,
	cellular: UPDATE_CELLULAR_OP,
};

/**
 * An action stays busy for as long as the browser still waits for its reply
 * (the default 15 s valve would hand the control back mid-request and invite a
 * second dispatch) and no longer: the client's own timeout always ends it.
 */
const ACTION_PENDING_TTL_MS = RPC_CALL_TIMEOUT_MS + 5_000;

export interface ActionRefusal {
	readonly action: UpdateActionKind;
	readonly reason: string | undefined;
	readonly retryable?: boolean;
}

/** What the actions read from the surface that owns the device reads. */
export interface ActionEvidenceSource {
	evidence(): ActionEvidence;
	/** The latest details read STARTED; a request sent now is newer than it. */
	latestRead(): number;
	reloadDetails(): Promise<void>;
}

export interface UpdateActions {
	readonly refusal: ActionRefusal | undefined;
	/** An action whose reply never arrived and that the device has not settled yet. */
	readonly unconfirmed: UpdateActionKind | undefined;
	pending(action: UpdateActionKind): boolean;
	run(
		action: UpdateActionKind,
		call: () => Promise<{ success: boolean; error?: string }>,
	): Promise<void>;
	/** A phase the device pushed: evidence for every action awaiting an outcome. */
	observe(phase: UpdateOrchestratorPhase): void;
	/** Re-judge the unconfirmed action against the surface's current reads. */
	settle(): void;
	reset(): void;
}

export function createUpdateActions(
	source: ActionEvidenceSource,
): UpdateActions {
	let refusal = $state.raw<ActionRefusal | undefined>();
	let unconfirmed = $state.raw<ActionWatch | undefined>();
	let session = 0;
	const inFlight = new Map<UpdateActionKind, ActionWatch>();

	function settle(): void {
		if (
			unconfirmed !== undefined &&
			actionSettled(unconfirmed, source.evidence())
		)
			unconfirmed = undefined;
	}

	async function run(
		action: UpdateActionKind,
		call: () => Promise<{ success: boolean; error?: string }>,
	): Promise<void> {
		const opened = session;
		refusal = undefined;
		unconfirmed = undefined;
		const failure = new UpdateActionFailure();
		const result = await osCommand({
			key: ACTION_OPS[action],
			pendingTtlMs: ACTION_PENDING_TTL_MS,
			rpc: () => {
				const { details } = source.evidence();
				inFlight.set(action, watchAction(action, source.latestRead(), details));
				return failure.run(call);
			},
			confirmOnResolve: true,
			silent: true,
		});
		if (opened !== session) return;
		const watch = inFlight.get(action);
		inFlight.delete(action);
		const verdict = failure.verdict(result);
		switch (verdict.kind) {
			case "started":
				break;
			case "refused":
				refusal = {
					action,
					reason: verdict.reason,
					...(verdict.retryable !== undefined
						? { retryable: verdict.retryable }
						: {}),
				};
				break;
			case "unconfirmed":
				if (watch !== undefined && !actionSettled(watch, source.evidence()))
					unconfirmed = watch;
				break;
			case "not-sent":
				return;
			default: {
				const unreachable: never = verdict;
				return unreachable;
			}
		}
		await source.reloadDetails();
	}

	return {
		get refusal() {
			return refusal;
		},
		get unconfirmed() {
			return unconfirmed?.action;
		},
		pending: (action) => getOperationPhase(ACTION_OPS[action]) === "pending",
		run,
		observe(phase) {
			for (const [action, watch] of inFlight)
				inFlight.set(action, withPhase(watch, phase));
			if (unconfirmed !== undefined)
				unconfirmed = withPhase(unconfirmed, phase);
			settle();
		},
		settle,
		reset() {
			session += 1;
			inFlight.clear();
			refusal = undefined;
			unconfirmed = undefined;
		},
	};
}
