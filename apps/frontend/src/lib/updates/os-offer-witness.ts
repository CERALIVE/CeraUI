/**
 * Positive evidence for "No newer system image has been found". Pure.
 *
 * The device keeps its OS candidate in MEMORY only, while the OS check clocks
 * and the phase survive a backend restart (round-3 review C, C3-2). A details
 * read showing `candidate: null` beside a successful clock therefore proves
 * nothing by itself: the process that answered may not be the one that ran
 * the check. The wire carries no process identity, so the only positive
 * evidence available is this dialog's own observation: a success clock it saw
 * APPEAR on one uninterrupted link (a backend restart always drops the link),
 * read with no candidate and nothing staged. That read came from the process
 * that ran the check, so its empty candidate is that check's answer. A pushed
 * system-image phase seen afterwards (an offer appeared, a stage started)
 * withdraws the verdict until a read establishes the new state.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";

import { SYSTEM_IMAGE_PHASES } from "./update-dialog-view";

export interface OsCheckWitness {
	/** The link the reads were STARTED on (`getLinkEpoch()` at dispatch). */
	readonly link: number | undefined;
	/** The newest OS success clock read on this link. */
	readonly latest: number | null;
	/** A success clock this link saw appear with nothing offered or staged. */
	readonly emptyAt: number | undefined;
}

export const NO_WITNESS: OsCheckWitness = {
	link: undefined,
	latest: null,
	emptyAt: undefined,
};

function offersNothing(details: UpdateDetails): boolean {
	return details.os.candidate === null && details.os.staged === null;
}

/** Folds one details read that landed on `link` into the witness. */
export function witnessRead(
	witness: OsCheckWitness,
	link: number,
	details: UpdateDetails,
): OsCheckWitness {
	const at = details.checks.os.lastSuccessAt;
	// The first read on a link is a baseline: whatever its clock says was
	// decided before this dialog was watching, possibly by another process.
	if (witness.link !== link) return { link, latest: at, emptyAt: undefined };
	if (at === null || at === witness.latest) return witness;
	return {
		link,
		latest: at,
		emptyAt: offersNothing(details) ? at : undefined,
	};
}

/** A pushed phase: an offer or a stage means the read verdict is stale. */
export function witnessPhase(
	witness: OsCheckWitness,
	phase: UpdateOrchestratorPhase,
): OsCheckWitness {
	if (witness.emptyAt === undefined || !SYSTEM_IMAGE_PHASES.includes(phase))
		return witness;
	return { ...witness, emptyAt: undefined };
}

/**
 * True only when the CURRENT success clock is one this link saw appear empty,
 * and the details still offer and stage nothing.
 */
export function witnessedNothingNewer(
	witness: OsCheckWitness,
	link: number,
	details: UpdateDetails | undefined,
): boolean {
	if (details === undefined || witness.link !== link) return false;
	return (
		witness.emptyAt !== undefined &&
		details.checks.os.lastSuccessAt === witness.emptyAt &&
		offersNothing(details)
	);
}
