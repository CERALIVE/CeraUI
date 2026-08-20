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
 * THE THREE ANSWERS A MODEM MUTATION MAY GIVE — `DESIGN.md` §8 (LR-1 … LR-6) in
 * code, pure and rune-free.
 *
 * A write to a modem or to a dongle's own admin API can end in exactly three
 * places, and collapsing any two of them is a lie:
 *
 *   `applied`  — the DEVICE was re-read and reports the requested value.
 *   `refused`  — the device said no. Nothing changed, and we know that.
 *   `unknown`  — the write was accepted and the confirming read never arrived
 *                inside its bound. The write's fate is genuinely unknown, so it
 *                is neither a success nor a failure and must not be rendered as
 *                either. This is LR-6's third arm and the reason a bounded
 *                mutation never ends in silence or in an endless spinner.
 *
 * TWO PROPERTIES ARE LOAD-BEARING, and both are why this is a TYPE rather than a
 * pair of booleans at each call site:
 *
 *  - **POLITENESS FOLLOWS THE KIND, NOT THE SURFACE (LR-2).** A success is
 *    routine progress and announces `polite`; a refusal and an unknown outcome
 *    both interrupt, so they announce `assertive`. Nothing on these surfaces may
 *    use `assertive` for a success. Deriving that per component is how one
 *    surface ends up shouting a success and another swallowing a refusal.
 *  - **THE MESSAGE IS ALREADY LOCALIZED (LR-4).** This module never sees a wire
 *    token, so it structurally cannot leak one: a caller resolves its own typed
 *    refusal through its own keyed copy and hands the operator's sentence in.
 *    That keeps the refusal vocabularies (`setRouterControl`'s four errors,
 *    `setGps`'s fourteen, …) where they already live instead of growing a second
 *    catalog here.
 *
 * An outcome is PERSISTENT by contract: the band that renders it stays on screen
 * until the next dispatch clears it. A toast was the retired behaviour, and it is
 * the defect this replaces — a router write that answered `not_applied` told the
 * operator so for four seconds and then presented a surface that looked exactly
 * like one where nothing had ever been attempted.
 */

export type MutationOutcomeKind = "applied" | "refused" | "unknown";

export interface MutationOutcome {
	readonly kind: MutationOutcomeKind;
	/**
	 * The operator's sentence, ALREADY resolved through the i18n catalog by the
	 * caller. Never a wire token, never a dotted key (LR-4 / OL-5).
	 */
	readonly message: string;
}

/**
 * Whether this outcome interrupts (LR-2).
 *
 * `unknown` is grouped with `refused` deliberately: an operator who cannot be
 * told whether their change took effect needs to hear that at least as urgently
 * as a clean refusal — the refusal at least settles the question.
 */
export function outcomeIsAssertive(kind: MutationOutcomeKind): boolean {
	return kind !== "applied";
}

/**
 * The ARIA role for the VISIBLE band.
 *
 * It is deliberately NOT a live region — the announcement rides the dedicated
 * sr-only regions that are mounted before any outcome can fire (LR-1). Giving
 * the visible band a live role too would announce every outcome twice, which is
 * the LR-3 "exactly once" failure in its friendliest disguise.
 */
export function outcomeBandRole(_kind: MutationOutcomeKind): undefined {
	return undefined;
}

/** The tone token each kind renders in. Colour is reinforcement, never the signal. */
export function outcomeTone(
	kind: MutationOutcomeKind,
): "success" | "error" | "warning" {
	switch (kind) {
		case "applied":
			return "success";
		case "refused":
			return "error";
		case "unknown":
			return "warning";
	}
}

/**
 * Build an outcome, or `undefined` when there is no sentence to show.
 *
 * An outcome with an EMPTY message is refused rather than rendered: a band with
 * no words is a coloured mark, and a state carried by a mark alone is a state
 * the operator cannot read.
 */
export function mutationOutcome(
	kind: MutationOutcomeKind,
	message: string,
): MutationOutcome | undefined {
	return message.trim().length === 0 ? undefined : { kind, message };
}
