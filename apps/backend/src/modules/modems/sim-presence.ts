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
 * IS THERE A SIM IN THIS MODEM? — read from ModemManager, never inferred.
 *
 * The wire's `no_sim` used to be derived from the ABSENCE OF A NETWORKMANAGER
 * GSM PROFILE, which is a different fact entirely: a profile is provisioned
 * only once a SIM has been read AND a connection has been created for it, so a
 * modem holding a perfectly good SIM that has not registered yet — or one whose
 * network is refusing it — has no profile and was reported as having no SIM.
 *
 * Board-measured on a Quectel RM530N-GL (2026-08-18): `mmcli -m 3` reported
 * `modem.generic.sim: /org/freedesktop/ModemManager1/SIM/0`, an occupied SIM
 * slot, `lock: sim-pin2`, the SIM's own number, and `state: searching` with the
 * network answering `gprs-and-non-gprs-not-allowed`. CeraUI simultaneously
 * rendered "No SIM card detected" in the modem dialog while offering the SMS
 * inbox and an "optional SIM unlock" band for that same card — three surfaces
 * disagreeing because exactly one of them was reading the wrong fact.
 *
 * THREE ANSWERS, and the third is not a synonym for the second:
 *
 *   - `present` — MM named a SIM object, so a card is in a slot. This is the
 *     ONLY value that suppresses `no_sim`, and it does so regardless of whether
 *     a profile exists, whether the card is PIN-locked, and whether the radio
 *     ever registered.
 *   - `absent` — MM said WHY the modem failed and the reason was `sim-missing`.
 *     A positive statement, not an inference from silence.
 *   - `unknown` — neither. The read could not answer, so nothing is claimed and
 *     the caller keeps whatever it already had (the same rule
 *     `deriveNetworkTypes` follows for an unreadable `-K` payload).
 *
 * The `unknown` arm is what keeps this change conservative: a device that
 * reports neither signal keeps the pre-existing profile-absence behaviour, so
 * no modem class silently stops reporting a genuinely missing SIM.
 */

import type { ModemInfo } from "./mmcli.ts";

export type SimPresence = "present" | "absent" | "unknown";

/**
 * A populated SIM slot names a real MM `Sim` object. An EMPTY slot is published
 * as the bare root path `/` (board-measured on the SIMCom SIM7600G-H, whose two
 * slots both read `/`), so matching the object-path shape — rather than testing
 * for a non-empty string — is what tells the two apart.
 */
const SIM_OBJECT_PATH_RE = /^\/org\/freedesktop\/ModemManager1\/SIM\/\d+$/;

/** MM's own token for "this modem failed because there is no SIM in it". */
export const SIM_MISSING_FAILED_REASON = "sim-missing";

export function isSimObjectPath(value: unknown): boolean {
	return typeof value === "string" && SIM_OBJECT_PATH_RE.test(value.trim());
}

/**
 * Resolve SIM presence from a parsed `mmcli -K -m <id>` payload.
 *
 * The primary SIM path is asked first because it is the direct answer; the slot
 * list is a fallback for firmware that populates only the multi-SIM view. The
 * failed-reason is consulted LAST so a modem that reports both a SIM object and
 * a stale `sim-missing` failure still resolves `present` — a card MM can name
 * is a card that is physically there.
 */
export function deriveSimPresence(modemInfo: Readonly<ModemInfo>): SimPresence {
	if (isSimObjectPath(modemInfo["modem.generic.sim"])) {
		return "present";
	}

	const slots = modemInfo["modem.generic.sim-slots"];
	if (Array.isArray(slots) && slots.some(isSimObjectPath)) {
		return "present";
	}

	const failedReason = modemInfo["modem.generic.state-failed-reason"]?.trim();
	if (failedReason === SIM_MISSING_FAILED_REASON) {
		return "absent";
	}

	return "unknown";
}

/**
 * Should the wire claim `no_sim` for a device whose SIM CeraUI can see and that
 * carries no NetworkManager profile?
 *
 * The ONE place the profile-vs-SIM distinction is resolved, shared by the
 * legacy builder and the Phase-B projection so the two cannot disagree about a
 * modem. Only PROVEN presence suppresses the claim.
 */
export function claimsNoSim(presence: SimPresence | undefined): boolean {
	return presence !== "present";
}
