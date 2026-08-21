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
 * The modem-mutation journal's VERSIONED state machine, as pure data.
 *
 * Everything here is a total function over the state set — no I/O, no clock, no
 * device. That separation is what lets the durability harness inject filesystem
 * faults around transitions without also having to fake a state machine, and
 * what lets every legal and illegal transition be enumerated in a unit test.
 *
 * The three properties the rest of the contract leans on:
 *
 *  - a transition is journaled BEFORE it is acted on, so the legality table is
 *    consulted on the WRITE path rather than after the fact;
 *  - blocking is derived from the state, never tracked separately — a second
 *    source of "is this device blocked" is how a fail-closed guard drifts open;
 *  - `blocksStreaming` and `blocksMutations` are DIFFERENT questions. A
 *    decommissioned identity keeps refusing mutations forever while releasing
 *    global streaming, which is the whole reason a destroyed modem cannot
 *    permanently strand the remaining bonded links.
 */

import type { ModemMutationState } from "@ceraui/rpc/schemas";

/** What startup replay must DO with an entry found in a given state. */
export type ReplayAction =
	| "rollback"
	| "prune"
	| "remain-blocked"
	| "resume-archive"
	| "recheck-presence";

const LEGAL_TRANSITIONS: Readonly<
	Record<ModemMutationState, readonly ModemMutationState[]>
> = {
	armed: ["executing", "completed", "failed", "device-absent-quarantine"],
	executing: ["completed", "failed", "device-absent-quarantine"],
	// A completed mutation is pruned, not advanced: the entry exists to describe
	// an outstanding risk, and there is no longer one.
	completed: [],
	failed: ["acknowledged", "device-absent-quarantine"],
	// Archived immediately after; retained as a state so a crash between the
	// acknowledgement write and the archive is replayable rather than ambiguous.
	acknowledged: [],
	"device-absent-quarantine": ["failed", "decommissioned"],
	// NOT terminal. Identity is PORT-based for serial-less devices, so a
	// REPLACEMENT modem in the same port inherits the key and must be noticed.
	decommissioned: ["recommission-pending"],
	"recommission-pending": ["acknowledged"],
};

/**
 * States whose device may not be mutated. Note that `armed` and `executing` are
 * included even though the in-process lease already covers a live mutation: after
 * a crash the lease is gone and the journal is the only surviving evidence that a
 * mutation was in flight, so the state itself has to carry the refusal.
 */
const MUTATION_BLOCKING: ReadonlySet<ModemMutationState> = new Set([
	"armed",
	"executing",
	"failed",
	"device-absent-quarantine",
	"decommissioned",
	"recommission-pending",
]);

/**
 * States that additionally hold GLOBAL stream autostart. Deliberately a strict
 * subset: an operator-confirmed decommission (and the recommission-pending state
 * that can follow it) releases streaming while still refusing mutations to that
 * one identity.
 */
const STREAMING_BLOCKING: ReadonlySet<ModemMutationState> = new Set([
	"armed",
	"executing",
	"failed",
	"device-absent-quarantine",
]);

const REPLAY_TABLE: Readonly<Record<ModemMutationState, ReplayAction>> = {
	// Restoring the pre-state is safe BY CONSTRUCTION for both in-flight states:
	// `armed` means the mutation had not been dispatched, and `executing` means it
	// may have been, so in both cases the pre-state is either already current or
	// the state the device should be returned to.
	armed: "rollback",
	executing: "rollback",
	completed: "prune",
	failed: "remain-blocked",
	acknowledged: "resume-archive",
	"device-absent-quarantine": "recheck-presence",
	decommissioned: "recheck-presence",
	"recommission-pending": "remain-blocked",
};

export function isLegalMutationTransition(
	from: ModemMutationState,
	to: ModemMutationState,
): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalMutationTransitions(
	from: ModemMutationState,
): readonly ModemMutationState[] {
	return LEGAL_TRANSITIONS[from];
}

export function blocksMutations(state: ModemMutationState): boolean {
	return MUTATION_BLOCKING.has(state);
}

export function blocksStreaming(state: ModemMutationState): boolean {
	return STREAMING_BLOCKING.has(state);
}

export function replayActionFor(state: ModemMutationState): ReplayAction {
	return REPLAY_TABLE[state];
}

/**
 * Where a `recheck-presence` replay lands, given whether the device is there.
 *
 * A quarantined device that came back returns to `failed` so ORDINARY fail-closed
 * handling resumes — it is not silently forgiven for having been away. A
 * decommissioned identity that is occupied again becomes `recommission-pending`
 * whether the returning unit is the original modem or a replacement, because the
 * port-based key cannot tell those apart and adopting either silently would
 * inherit the previous unit's baseline.
 */
export function presenceRecheckTarget(
	state: ModemMutationState,
	devicePresent: boolean,
): ModemMutationState | undefined {
	if (state === "device-absent-quarantine") {
		return devicePresent ? "failed" : undefined;
	}
	if (state === "decommissioned") {
		return devicePresent ? "recommission-pending" : undefined;
	}
	return undefined;
}

/** States whose entry is removed from the journal rather than kept. */
export function isArchivable(state: ModemMutationState): boolean {
	return state === "completed" || state === "acknowledged";
}
