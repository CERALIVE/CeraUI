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
 * Per-modem ROAMING ADVISORY — informational, keyed, and RETRACTABLE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT NEVER GATES ANYTHING
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module tells an operator that a modem is registered on a partner network
 * — nothing else. It does NOT decide whether a link joins the bond, whether a
 * stream may start, or what bitrate the encoder runs at, and it imports nothing
 * from `streaming/`, `network/` or the srtla surface so it CANNOT grow one by
 * accident. `tests/modem-roaming-advisory.test.ts` pins both halves of that: a
 * static import gate over this file, and a behavioural assertion that the
 * `modems` payload is byte-identical whether or not an advisory is standing.
 *
 * Roaming is a BILLING fact, not a health fact. Refusing to bond a roaming link
 * would take a working stream off the air over a cost the operator may well have
 * already accepted; saying nothing at all is how a data bill becomes a surprise.
 * The honest middle is a calm `info` notification plus a row badge, both of
 * which go away on their own the moment the fact stops being true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A PERSISTENT NOTIFICATION MUST BE RETRACTABLE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `notificationRemaining()` returns `NOTIFICATION_LIVES_FOREVER` for EVERY
 * persistent notification, so a raise site with no matching retraction latches
 * for the whole session (see `apps/backend/AGENTS.md` → "A PERSISTENT
 * NOTIFICATION MUST BE RETRACTABLE"). This advisory's retraction evidence is the
 * modem's OWN NEXT REGISTRATION STATE, never a timer:
 *
 *   - `status.roaming` reads `false` on a later broadcast  ⇒ retract;
 *   - the modem is ABSENT from a later broadcast           ⇒ retract.
 *
 * The second rule is the `policy_route_missing` latch class, and it is why the
 * evaluator takes the WHOLE modem list rather than one modem at a time: a
 * device-absent modem emits no further registration states, so a per-modem
 * evaluator would never see the evidence that falsifies its own claim, and the
 * advisory would stand for the rest of the session on a dongle physically pulled
 * out of the board. The membership table below is the current roaming set, and
 * every standing name outside it is retracted on the same pass — one code path
 * for "roaming ended" and "device gone", because from this module's side of the
 * wire they are the same statement: this modem is not roaming right now.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SLOT KEY, AND WHY A KEYLESS MODEM IS SUPPRESSED
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A notification `name` is the removal identity, so two modems sharing one name
 * means the second raise overwrites the first and the first RETRACTION clears
 * both — a silent lie in either direction. The key chain is therefore stated,
 * not assumed:
 *
 *   1. `stable_key` — the ID_PATH-anchored identity (todo 22). Preferred: it is
 *      the only key that survives a USB re-enumeration, so a modem that replugs
 *      mid-episode keeps ONE advisory instead of accumulating one per numeric id.
 *   2. the legacy wire id — the `modems` record key. `stable_key` is OPTIONAL by
 *      todo 17's own contract (no udev `ID_PATH` ⇒ the field is omitted), and a
 *      PCIe/older-kernel modem that never gets one still deserves the advisory.
 *   3. NEITHER ⇒ SUPPRESSED. Not "fall back to the ifname", not "share a slot":
 *      an advisory that cannot be addressed cannot be retracted, and an unkeyed
 *      raise is the raise-only site the house rule forbids. Staying silent about
 *      a roaming modem is a smaller failure than a permanent notification about
 *      one an operator can no longer identify.
 */

import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";

/**
 * Notification-name namespace. The full name is `modem_roaming:<slot>`; the
 * prefix is what keeps a modem slot from ever colliding with an unrelated
 * notification identity (`hdmi_error`, `netif_dup_ip`, `cerastream`, …).
 */
export const ROAMING_ADVISORY_PREFIX = "modem_roaming:";

/** i18n key the frontend resolves; `msg` below is the English wire fallback. */
export const ROAMING_ADVISORY_KEY = "notifications.modemRoaming";

/** English fallback copy, used when a client cannot resolve the key. */
export function roamingAdvisoryMsg(label: string): string {
	return `${label} is roaming. It's registered on a partner network, so data may be billed at roaming rates. Streaming is unaffected.`;
}

/**
 * One modem's roaming truth, reduced to what the advisory needs. Deliberately
 * NOT the wire `Modem` type: the evaluator is fixture-driven and must stay
 * testable without constructing a full wire row.
 */
export interface RoamingObservation {
	/** `stable_key` when the producer could anchor one (todo 22). */
	stableKey?: string | undefined;
	/** The legacy wire id — the `modems` record key. */
	wireId?: string | undefined;
	/** Operator-facing device label, interpolated into the copy. */
	label: string;
	/** The modem's OWN registration claim (`status.roaming`), not the config. */
	roaming: boolean;
}

/** Injected effectful surface (defaults wire the real broadcast path). */
export interface RoamingAdvisoryDeps {
	notify: typeof notificationBroadcast;
	removeNotification: typeof notificationRemove;
}

function defaultDeps(): RoamingAdvisoryDeps {
	return {
		notify: notificationBroadcast,
		removeNotification: notificationRemove,
	};
}

let advisoryDeps: RoamingAdvisoryDeps = defaultDeps();

/**
 * The MEMBERSHIP TABLE: notification name → the label it was raised with.
 * Presence == "an advisory is standing for this slot", which is exactly the set
 * a broadcast has to reconcile against. Absent == nothing raised, so the healthy
 * steady state (no modem roaming) costs one empty-map walk and broadcasts
 * nothing.
 */
const standingAdvisories = new Map<string, string>();

/** Test seam: swap notify/remove (null restores production wiring). */
export function setRoamingAdvisoryDepsForTest(
	deps: RoamingAdvisoryDeps | null,
): void {
	advisoryDeps = deps ?? defaultDeps();
	standingAdvisories.clear();
}

/** Drop all advisory state (per-test isolation; also used on a fresh start). */
export function resetRoamingAdvisoryState(): void {
	standingAdvisories.clear();
}

/** The notification names currently standing, for assertions and diagnostics. */
export function standingRoamingAdvisoryNames(): string[] {
	return [...standingAdvisories.keys()];
}

function firstNonBlank(...candidates: Array<string | undefined>) {
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed !== "") return trimmed;
	}
	return undefined;
}

/**
 * The advisory's addressable slot, or `undefined` when the modem carries no
 * usable identity at all — see the key chain in this file's header. `undefined`
 * SUPPRESSES the advisory; it never falls through to a shared slot.
 */
export function roamingAdvisorySlot(
	observation: RoamingObservation,
): string | undefined {
	return firstNonBlank(observation.stableKey, observation.wireId);
}

/** The full notification name for a slot. */
export function roamingAdvisoryName(slot: string): string {
	return `${ROAMING_ADVISORY_PREFIX}${slot}`;
}

/**
 * The narrowest possible view of a wire modem row — only the four fields the
 * advisory reads. Structural on purpose: `buildModemsWireMessage` returns the
 * PROJECTED message on the happy path and the LEGACY builder's message on the
 * fail-safe fallback, and the advisory must reconcile identically over either
 * without either one's full type being imported here.
 */
export interface RoamingWireModem {
	stable_key?: string | undefined;
	name?: string | undefined;
	ifname?: string | undefined;
	status?: { roaming?: boolean | undefined } | undefined;
}

/**
 * Reduce a built `modems` wire message to the advisory's inputs.
 *
 * `status.roaming` is the ONLY roaming signal read here. `config.roaming` is the
 * operator's PERMISSION for the modem to roam — a modem sitting on its home
 * network with roaming allowed is not roaming, and advising otherwise would
 * report a setting back to the person who set it.
 */
export function roamingObservationsFromWire(
	message: Readonly<Record<string, RoamingWireModem>>,
): RoamingObservation[] {
	const observations: RoamingObservation[] = [];
	for (const [wireId, modem] of Object.entries(message)) {
		observations.push({
			stableKey: modem.stable_key,
			wireId,
			label: firstNonBlank(modem.name, modem.ifname) ?? wireId,
			roaming: modem.status?.roaming === true,
		});
	}
	return observations;
}

/**
 * Reconcile the advisory set against ONE broadcast's worth of modem truth.
 *
 * `observations` must be the COMPLETE list the broadcast carries: absence from
 * it is the retraction evidence for a device that disappeared, so a partial list
 * would retract advisories about modems that are merely not in it.
 *
 * Returns the names raised and retracted on this pass, so a test can assert the
 * edge without inspecting the notify spy.
 */
export function evaluateRoamingAdvisories(
	observations: readonly RoamingObservation[],
	deps: RoamingAdvisoryDeps = advisoryDeps,
): { raised: string[]; retracted: string[] } {
	const current = new Map<string, string>();
	for (const observation of observations) {
		if (!observation.roaming) continue;
		const slot = roamingAdvisorySlot(observation);
		if (slot === undefined) continue; // keyless ⇒ suppressed, never shared
		current.set(roamingAdvisoryName(slot), observation.label);
	}

	// Retract first: a modem whose roaming episode ended, and a modem that left
	// the broadcast entirely, are the same statement and take the same path.
	const retracted: string[] = [];
	for (const name of [...standingAdvisories.keys()]) {
		if (current.has(name)) continue;
		standingAdvisories.delete(name);
		deps.removeNotification(name);
		retracted.push(name);
	}

	// Raise only on the ENTRY edge. A re-broadcast of an unchanged roaming state
	// finds the name already standing and emits nothing — one raise per episode,
	// including when the device's label changes mid-episode (a renamed modem is
	// not a new roaming event, and re-toasting on it would be the dedupe bug this
	// contract exists to prevent).
	const raised: string[] = [];
	for (const [name, label] of current) {
		if (standingAdvisories.has(name)) continue;
		standingAdvisories.set(name, label);
		deps.notify(
			name,
			"info",
			roamingAdvisoryMsg(label),
			0, // persistent: `duration` does not expire one anyway
			true, // isPersistent — it stands until the modem says otherwise
			true, // isDismissable — the documented safety net (see below)
			true, // authedOnly
			ROAMING_ADVISORY_KEY,
			{ name: label },
		);
		raised.push(name);
	}

	return { raised, retracted };
}

/**
 * The broadcast-seam entry point: evaluate the advisory set against the message
 * that is going out, and NEVER let a failure here touch the broadcast.
 *
 * `isDismissable: true` is a safety net, not the mechanism. The automatic
 * retraction above is the primary path and depends only on the modem list still
 * being produced — but a wedged poll loop or a backend that stops enumerating
 * leaves the operator with a notification the device can no longer retract. The
 * manual affordance costs nothing when the automatic path works and is the only
 * recourse when it cannot run.
 */
export function evaluateRoamingAdvisoriesForWire(
	message: Readonly<Record<string, RoamingWireModem>>,
	deps: RoamingAdvisoryDeps = advisoryDeps,
): { raised: string[]; retracted: string[] } {
	return evaluateRoamingAdvisories(roamingObservationsFromWire(message), deps);
}
