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
 * WHAT THE USSD SECTION RENDERS, AS PURE DATA.
 *
 * USSD is the one capability on this surface that is a SESSION rather than a
 * setting, so it needs a state machine of its own on top of the four-state
 * capability contract — which is expected: the ladder answers "may this control
 * be offered", and it has no vocabulary for "the network asked a question and is
 * holding a slot open until you answer".
 *
 * ── WHY A SECOND MACHINE, AND WHY IT MIRRORS THE DEVICE'S ────────────────────
 *
 * The device already owns the authoritative machine
 * (`modem-stack/control/src/ussd/session.ts` → CeraUI's own
 * `apps/backend/.../ussd-session.ts`), and it REFUSES an illegal verb with a
 * typed reason rather than throwing. So the UI could simply dispatch and render
 * the refusal — and that is exactly what must not happen for `initiate`.
 *
 * A USSD session is a NETWORK-side resource: the subscriber gets ONE, and a
 * dialogue left open fails the next `Initiate` busy for reasons nothing on
 * screen explains. Dispatching a second `initiate` against a live dialogue is
 * therefore not merely futile, it spends a round-trip on a verb whose only
 * possible answer is `session-busy`. {@link canInitiateUssd} and its two
 * siblings mirror the device's OWN accept sets so the surface refuses locally,
 * with the reason already on screen, and the RPC never leaves.
 *
 * The mirrors are NARROWER than the device's authority, never wider: every verb
 * the UI admits is still re-judged by the machine that owns the session, so a
 * mirror that drifts optimistic costs a refusal rather than a double-open.
 *
 * ── THE CARRIER'S TEXT NEVER REACHES THIS MODULE ─────────────────────────────
 *
 * Nothing here accepts, stores, formats or returns a command or a reply. Both
 * directions carry subscriber content — a USSD dialogue is how a prepaid line is
 * topped up, so the command routinely carries a voucher code and the reply a
 * balance or a one-time code — and the device redacts both by FIELD NAME at
 * every log boundary. A helper here that took one as an argument would be a
 * second place it could be interpolated into a message, a key, or a log line.
 * {@link isValidUssdCommand} is the sole exception and it returns a BOOLEAN: it
 * reads the shape and says nothing about the content.
 */

import type {
	SupportClaimState,
	UssdRefusal,
	UssdSessionOutcome,
	UssdSessionSnapshot,
	UssdSessionState,
} from "@ceraui/rpc/schemas";
import {
	USSD_COMMAND_RE,
	USSD_RESPONSE_RE,
	USSD_TEXT_MAX,
} from "@ceraui/rpc/schemas";

import {
	type CapabilityReasonKeys,
	resolveCapabilityRender,
} from "$main/network/capability-modules";

import type { MutationOutcomeKind } from "./mutation-outcome";
import type { CapabilityView } from "./sections";

const REASONS: CapabilityReasonKeys = {
	moduleDisabled: "network.modem.ussd.reason.moduleDisabled",
	unproven: "network.modem.ussd.reason.unproven",
};

/**
 * The capability ladder for USSD — deliberately only THREE of the four states.
 *
 * `blocked` is never returned, and that is the notepad's third documented
 * pattern applied verbatim: `CapabilitySection` SUPPRESSES `children` at
 * `blocked`, and here the session surface (the command form, the dialogue, the
 * outcome band) IS the children. A `blocked` view would therefore take the whole
 * dialogue off screen at exactly the moment the operator needs to read why it
 * stopped.
 *
 * A device-side refusal that stands right now is rendered INSIDE the surface
 * instead — the form disabled, the reason beside it — which is the same CT-2
 * treatment reached without discarding the session it is refusing.
 */
export function ussdCapabilityView(
	claim: SupportClaimState | undefined,
): CapabilityView {
	const view = resolveCapabilityRender(claim, REASONS);
	// `resolveCapabilityRender` cannot answer `blocked` with no blocked reason
	// passed, but narrowing here is what makes that a property of THIS function
	// rather than of the call above it.
	return view.mode === "blocked" ? { mode: "available" } : view;
}

/**
 * WHERE THE DIALOGUE IS, in the operator's terms.
 *
 * Five phases, folded from the device's seven states, and the fold is the whole
 * point: three of those states (`initiating` / `responding` / `cancelling`) are
 * LOCAL in-flight markers that differ only in which verb is outstanding, and an
 * operator watching a spinner does not need to be told which. What they must
 * never see is a spinner with no end, which is why `working` is always followed
 * by a terminal phase — the device closes an unanswered dialogue at its own
 * bound and reports `closed`/`timed-out`.
 *
 *   idle           — no dialogue. The command form is live.
 *   working        — a verb is in flight. BOUNDED by the device, never endless.
 *   awaiting-reply — the network asked a question. The answer form is live.
 *   open           — the dialogue is open with nothing pending; only cancel is legal.
 *   closed         — terminal. The outcome band says HOW it ended.
 */
export type UssdSurfacePhase =
	| "idle"
	| "working"
	| "awaiting-reply"
	| "open"
	| "closed";

const PHASE_BY_STATE: Readonly<Record<UssdSessionState, UssdSurfacePhase>> = {
	idle: "idle",
	initiating: "working",
	responding: "working",
	cancelling: "working",
	active: "open",
	"awaiting-reply": "awaiting-reply",
	closed: "closed",
};

/** An absent snapshot is `idle`: nothing has been opened, so nothing is open. */
export function ussdSurfacePhase(
	session: UssdSessionSnapshot | undefined,
): UssdSurfacePhase {
	return session === undefined ? "idle" : PHASE_BY_STATE[session.state];
}

/**
 * True while the dialogue still holds the subscriber's single network-side slot.
 *
 * The mirror of the device's own `isUssdSessionOpen`, and the reason a second
 * `initiate` is refused before it is dispatched.
 */
export function isUssdDialogueLive(
	session: UssdSessionSnapshot | undefined,
): boolean {
	if (session === undefined) return false;
	return session.state !== "idle" && session.state !== "closed";
}

/**
 * ── THE THREE VERB MIRRORS ───────────────────────────────────────────────────
 *
 * Each mirrors the accept set of the device's own machine. They are stated as
 * explicit sets rather than derived from {@link isUssdDialogueLive} because the
 * three are genuinely different questions: `cancel` is legal on four states,
 * `respond` on exactly one, and `initiate` only on the two that hold no slot.
 */
const ACCEPTS_INITIATE: ReadonlySet<UssdSessionState> =
	new Set<UssdSessionState>(["idle", "closed"]);
const ACCEPTS_RESPOND: ReadonlySet<UssdSessionState> =
	new Set<UssdSessionState>(["awaiting-reply"]);
const ACCEPTS_CANCEL: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>(
	["initiating", "active", "awaiting-reply", "responding"],
);

/**
 * May a NEW dialogue be opened?
 *
 * `closed` is admitted here although the DEVICE's machine refuses it, and the
 * asymmetry is deliberate rather than drift: the device's `closed` is terminal
 * for one session OBJECT and its adapter starts the next dialogue from a fresh
 * machine (it stores a terminal snapshot as `idle`). So `closed` on this surface
 * means "the last dialogue ended", which is precisely when a new one is legal.
 */
export function canInitiateUssd(
	session: UssdSessionSnapshot | undefined,
): boolean {
	return session === undefined || ACCEPTS_INITIATE.has(session.state);
}

/** May the operator answer? Only while the network is actually asking. */
export function canRespondUssd(
	session: UssdSessionSnapshot | undefined,
): boolean {
	return session !== undefined && ACCEPTS_RESPOND.has(session.state);
}

/** May the dialogue be closed? Only while one is open and no cancel is in flight. */
export function canCancelUssd(
	session: UssdSessionSnapshot | undefined,
): boolean {
	return session !== undefined && ACCEPTS_CANCEL.has(session.state);
}

/**
 * ── THE REFUSAL VOCABULARY ───────────────────────────────────────────────────
 *
 * TOTAL over both enums a USSD answer can carry: the ten `ussdRefusalSchema`
 * members and the nine `capabilityMutationRefusalSchema` ones. An unmapped token
 * falls back to the generic transport failure rather than leaking itself into
 * copy — the rule the rest of the modem surface follows, and the one the modem
 * a11y gate forbids breaking.
 *
 * The list is spelled out rather than derived from the enums because these are
 * two DIFFERENT enums reached through two different fields (`error` and
 * `mutationRefusal`), and a copy key must exist for every member of both before
 * either can render. `ussd-session.test.ts` derives the required set FROM the
 * schemas and fails when a member has no key, so the completeness claim is
 * machine-checked rather than promised here.
 */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set<string>([
	// ussdRefusalSchema
	"unknown_modem",
	"unsupported",
	"lte-only-unsupported",
	"not-registered",
	"no-session",
	"session-busy",
	"invalid-state",
	"carrier-rejected",
	"timeout",
	"transport-failed",
	// capabilityMutationRefusalSchema
	"module_disabled",
	"module_unavailable",
	"identity_unresolved",
	"mutation_in_progress",
	"streaming_active",
	"recovery_pending",
	"mutation_blocked",
	"device_decommissioned",
	"rebaseline_required",
]);

export function ussdRefusalKey(token: string): string {
	return KNOWN_REFUSALS.has(token)
		? `network.modem.ussd.error.${token}`
		: "network.modem.ussd.error.transport-failed";
}

/**
 * IS THIS THE CARRIER'S POLICY RATHER THAN THE DEVICE'S LIMIT?
 *
 * `lte-only-unsupported` is the one refusal in the vocabulary that says nothing
 * at all about the hardware. USSD is a circuit-switched supplementary service,
 * so a modem attached LTE/5G-SA with no CS domain can only carry it where the
 * operator deployed USSI — and where they did not, the network answers an error
 * indistinguishable, on its face, from "this modem has no USSD interface". The
 * device separates the two from its OWN registration reading and only claims
 * this one on positive PS-only evidence.
 *
 * Rendering it as a generic failure would send an operator hunting for a
 * firmware fix for a carrier decision, which is why it gets its own band, its
 * own copy, and its own `data-ussd-policy` marker rather than a shared one.
 */
export function isNetworkPolicyRefusal(token: string | undefined): boolean {
	return token === "lte-only-unsupported";
}

/**
 * ── THE FOUR SESSION OUTCOMES ────────────────────────────────────────────────
 *
 * A dialogue ends in exactly four ways and every one of them is a different
 * thing to tell an operator. They are mapped onto the shared
 * {@link MutationOutcomeKind} vocabulary so the ONE `MutationOutcomeBand` the
 * capability section already mounts can carry them — a second band beside it
 * would announce the same fact twice.
 *
 * | Session outcome | Band kind | What the operator is told                    |
 * |-----------------|-----------|----------------------------------------------|
 * | `completed`     | `applied` | the network answered and released the slot   |
 * | `cancelled`     | `applied` | you closed it; the slot is released          |
 * | `timed-out`     | `unknown` | nobody answered, and the result is UNKNOWN   |
 * | `failed`        | `refused` | the network refused, and this is why         |
 *
 * `timed-out` → `unknown` is the load-bearing row. That band's whole contract is
 * "the write was accepted and the confirming read never arrived inside its
 * bound", which is exactly a USSD dialogue nobody answered: the network may have
 * acted on the last message and may not, so it is neither a success nor a
 * failure and must not be rendered as either. It is also what stops the surface
 * ending in a spinner — the device closes the dialogue at its own bound and this
 * is the terminal state that arrives.
 *
 * `cancelled` is `applied` rather than a fourth kind because the operator asked
 * for the dialogue to end and it ended: that is a request that took effect.
 */
export function ussdOutcomeKind(
	outcome: UssdSessionOutcome,
): MutationOutcomeKind {
	switch (outcome) {
		case "completed":
		case "cancelled":
			return "applied";
		case "timed-out":
			return "unknown";
		case "failed":
			return "refused";
	}
}

export interface UssdOutcomeView {
	/** The four-valued session outcome, for `data-` marking and for tests. */
	readonly outcome: UssdSessionOutcome;
	readonly kind: MutationOutcomeKind;
	/** The i18n key for the operator's sentence. Never a wire token. */
	readonly messageKey: string;
	/**
	 * The device's typed refusal, present only on `failed`. Kept beside the
	 * message so a caller can mark the network-policy case without re-deriving it.
	 */
	readonly refusal?: UssdRefusal;
}

/**
 * How the dialogue ended, or `undefined` while it has not.
 *
 * A `failed` outcome resolves its sentence from the device's OWN refusal, so the
 * band says why rather than "it failed" — and a `failed` snapshot that carries
 * no refusal (the device always sends one, but the field is optional on the
 * wire) degrades to the generic transport sentence rather than an empty band.
 */
export function ussdOutcomeView(
	session: UssdSessionSnapshot | undefined,
): UssdOutcomeView | undefined {
	if (session?.state !== "closed" || session.outcome === undefined) {
		return undefined;
	}
	const outcome = session.outcome;
	if (outcome === "failed") {
		return {
			outcome,
			kind: "refused",
			messageKey: ussdRefusalKey(session.refusal ?? "transport-failed"),
			...(session.refusal === undefined ? {} : { refusal: session.refusal }),
		};
	}
	return {
		outcome,
		kind: ussdOutcomeKind(outcome),
		messageKey: `network.modem.ussd.outcome.${outcome}`,
	};
}

/**
 * ── INPUT SHAPE, MIRRORED FROM THE WIRE ──────────────────────────────────────
 *
 * Both predicates re-use the schemas' OWN regexes rather than restating them, so
 * the surface cannot offer a Send button for a value the boundary will reject.
 * They answer a boolean and never echo, trim, normalise or return the value —
 * see this module's header for why nothing here handles carrier text.
 */
export function isValidUssdCommand(value: string): boolean {
	return value.length <= USSD_TEXT_MAX && USSD_COMMAND_RE.test(value);
}

export function isValidUssdResponse(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= USSD_TEXT_MAX &&
		USSD_RESPONSE_RE.test(value)
	);
}
