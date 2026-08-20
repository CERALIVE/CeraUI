/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The USSD session state machine — pure, total, and the only place a verb's
 * legality is decided.
 *
 * WHY A MACHINE AT ALL. USSD is a SESSION protocol, not request/response:
 * `Initiate` opens a dialogue the network may hold open pending a `Respond`, and
 * a session that is neither answered nor cancelled stays open NETWORK-side,
 * occupying the subscriber's single slot and failing the next `Initiate` busy.
 * So "which verb is legal right now" has a real wrong answer, and answering it
 * inside the mmcli layer would make it untestable without a modem.
 *
 * It is a Rule-D MIRROR of `@ceralive/modem-control`'s `ussd/session.ts`, not a
 * shared import — the pinned package predates that module, and the two halves are
 * kept honest by their tests rather than by a path. The same relationship
 * `capability-gates.ts` has with the support-claim ladder.
 *
 * THE MACHINE CARRIES NO CARRIER TEXT. The reply is threaded separately by
 * `ussd.ts` and masked by KEY at every log boundary, so a snapshot echoed onto
 * the wire or into a trace can never leak a balance or a voucher code.
 */

import type {
	UssdRefusal,
	UssdSessionSnapshot,
	UssdSessionState,
} from "@ceraui/rpc/schemas";

/** ModemManager's post-call session state, decoded. */
export type UssdRepliedState = "awaiting-reply" | "active" | "released";

export type UssdSessionEvent =
	| { readonly kind: "initiate" }
	| { readonly kind: "respond" }
	| { readonly kind: "cancel" }
	| { readonly kind: "replied"; readonly sessionState: UssdRepliedState }
	| { readonly kind: "cancelled" }
	| { readonly kind: "network-released" }
	| { readonly kind: "timeout" }
	| { readonly kind: "failed"; readonly reason: UssdRefusal };

export type UssdTransition =
	| { readonly ok: true; readonly snapshot: UssdSessionSnapshot }
	/** The verb is illegal here, and the machine did NOT move. */
	| { readonly ok: false; readonly refusal: UssdRefusal };

export const IDLE_USSD_SESSION: UssdSessionSnapshot = { state: "idle" };

const ACCEPTS_INITIATE: ReadonlySet<UssdSessionState> =
	new Set<UssdSessionState>(["idle"]);
const ACCEPTS_RESPOND: ReadonlySet<UssdSessionState> =
	new Set<UssdSessionState>(["awaiting-reply"]);
const ACCEPTS_CANCEL: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>(
	["initiating", "active", "awaiting-reply", "responding"],
);
/** The only states a network answer may land on. */
const IN_FLIGHT: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>([
	"initiating",
	"responding",
]);

function open(state: UssdSessionState): UssdTransition {
	return { ok: true, snapshot: { state } };
}

function close(
	outcome: NonNullable<UssdSessionSnapshot["outcome"]>,
	refusal?: UssdRefusal,
): UssdTransition {
	return {
		ok: true,
		snapshot: {
			state: "closed",
			outcome,
			...(refusal === undefined ? {} : { refusal }),
		},
	};
}

function refuse(refusal: UssdRefusal): UssdTransition {
	return { ok: false, refusal };
}

/**
 * Apply one event. TOTAL: every (state, event) pair answers either with a new
 * snapshot or with a typed refusal that leaves the caller's snapshot untouched.
 *
 * A `closed` machine accepts NOTHING. Re-opening a terminal session would hide
 * that the previous one ended; `ussd.ts` resets the STORED state to idle instead,
 * so the next dialogue starts from a fresh machine.
 */
export function reduceUssdSession(
	snapshot: UssdSessionSnapshot,
	event: UssdSessionEvent,
): UssdTransition {
	const state = snapshot.state;
	if (state === "closed") {
		return refuse("no-session");
	}
	// Every event but `initiate` describes something happening TO a session, and
	// an idle machine has none for them to happen to.
	const sessionOpen = state !== "idle";

	switch (event.kind) {
		case "initiate":
			return ACCEPTS_INITIATE.has(state)
				? open("initiating")
				: refuse("session-busy");

		case "respond":
			return ACCEPTS_RESPOND.has(state)
				? open("responding")
				: refuse("invalid-state");

		case "cancel":
			// Two different operator facts: nothing to close, vs a cancel already
			// in flight.
			if (ACCEPTS_CANCEL.has(state)) {
				return open("cancelling");
			}
			return refuse(sessionOpen ? "invalid-state" : "no-session");

		case "replied":
			if (!IN_FLIGHT.has(state)) {
				return refuse("invalid-state");
			}
			// Collapsing `active` into `released` is what would leave a session MM
			// still considers open dangling on the network side.
			return event.sessionState === "released"
				? close("completed")
				: open(event.sessionState);

		case "cancelled":
			return state === "cancelling"
				? close("cancelled")
				: refuse("invalid-state");

		case "network-released":
			if (!sessionOpen) {
				return refuse("no-session");
			}
			// During a cancel this IS the cancel landing: the operator asked for
			// the session to end and it ended.
			return close(state === "cancelling" ? "cancelled" : "completed");

		case "timeout":
			// Closing rather than reverting: after an unanswered call the network's
			// own view is unknown, and pretending we are back at `idle` would let
			// the next `initiate` walk into a busy error with no explanation.
			return sessionOpen ? close("timed-out") : refuse("no-session");

		case "failed":
			return sessionOpen ? close("failed", event.reason) : refuse("no-session");

		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** True while the session still holds a network dialogue open. */
export function isUssdSessionOpen(snapshot: UssdSessionSnapshot): boolean {
	return snapshot.state !== "idle" && snapshot.state !== "closed";
}
