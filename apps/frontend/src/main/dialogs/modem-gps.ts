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
 * What the GPS section renders, as pure data.
 *
 * The interesting decisions here are rules — WHEN the control is offered, and
 * WHAT an operator is told while there is no fix — and a rule stated once in a
 * `.ts` file can be tested against every input class without mounting anything.
 * It follows `modem-fcc-unlock.ts` exactly, for the same reason.
 *
 * THE PRIVACY FENCE REACHES THIS LAYER TOO: there is no history view, no export
 * button, and no map link. `gnssFixLine` renders ONE fix, the one currently in
 * the device's memory, and nothing accumulates.
 */

import type {
	GnssFix,
	GnssFixState,
	SupportClaimState,
} from "@ceraui/rpc/schemas";

export type GpsView =
	| { readonly kind: "hidden" }
	| { readonly kind: "blocked"; readonly reasonKey: string }
	| { readonly kind: "toggle"; readonly enabled: boolean };

/**
 * Resolve what to render for one modem. The ordering is the contract, and it is
 * `fccUnlockView`'s:
 *
 * 1. `unavailable` HIDES the section — this build does not ship the module, OR
 *    the modem positively has no GNSS receiver. An operator can act on neither,
 *    and a permanent disabled row on every non-GNSS modem is noise.
 * 2. `implemented` is BLOCKED-with-a-reason: the device-config gate is off and
 *    turning it on is the fix, so the control must be visible.
 * 3. `enabled` is also blocked — the gate is on but the capability read has not
 *    landed, and offering a control on an unproven capability is exactly what the
 *    capability floor exists to prevent.
 * 4. `capable`/`certified` render the toggle.
 */
export function gpsView(
	claim: SupportClaimState | undefined,
	status: { readonly gnssEnabled: boolean } | undefined,
): GpsView {
	if (claim === undefined || claim === "unavailable") {
		return { kind: "hidden" };
	}
	if (claim === "implemented") {
		return {
			kind: "blocked",
			reasonKey: "network.modem.gps.reason.moduleDisabled",
		};
	}
	if (claim === "enabled" || status === undefined) {
		return { kind: "blocked", reasonKey: "network.modem.gps.reason.unproven" };
	}
	return { kind: "toggle", enabled: status.gnssEnabled };
}

export type GpsStatusLine =
	| { readonly kind: "off" }
	/** A BOUNDED wait. `deadline` is what the copy states, so it is never open-ended. */
	| { readonly kind: "acquiring"; readonly deadline: number }
	| { readonly kind: "no-fix"; readonly reasonKey: string }
	| { readonly kind: "fix"; readonly fix: GnssFix }
	| { readonly kind: "unavailable" };

/**
 * The renderable form of the device's state.
 *
 * `no-fix` keys its copy on WHY, because the three reasons ask for different
 * things from an operator: a timed-out acquisition points at the antenna, a
 * receiver still reporting nothing is simply not locked on, and an expired fix
 * says the position went stale and was dropped rather than shown.
 */
export function gpsStatusLine(state: GnssFixState | undefined): GpsStatusLine {
	if (state === undefined) return { kind: "off" };
	switch (state.kind) {
		case "off":
			return { kind: "off" };
		case "acquiring":
			return { kind: "acquiring", deadline: state.deadline };
		case "no-fix":
			return {
				kind: "no-fix",
				reasonKey: `network.modem.gps.noFix.${state.reason}`,
			};
		case "fix":
			return { kind: "fix", fix: state.fix };
		case "unavailable":
			return { kind: "unavailable" };
	}
}

/**
 * A fix as ONE line of text.
 *
 * Six decimal places is ~0.1 m, which is far finer than any modem's GNSS is
 * accurate to — but truncating a coordinate makes it look like a different
 * place, so the device's own figure is rendered rather than a rounded one.
 * `dir="ltr"` is applied at the render site so an RTL locale cannot reorder the
 * two signed numbers.
 */
export function gnssFixLine(fix: GnssFix): string {
	const parts = [`${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`];
	if (fix.altitude !== undefined) {
		parts.push(`${Math.round(fix.altitude)} m`);
	}
	return parts.join(" · ");
}

/**
 * The i18n key for a `setGps` failure. A raw machine token is never rendered —
 * the rule the rest of the modem surface follows — and an UNMAPPED token falls
 * back to the generic write failure rather than leaking itself into copy.
 */
export function gpsErrorKey(token: string): string {
	const known = new Set([
		"unsupported",
		"not_enabled",
		"unknown_modem",
		"read_failed",
		"module_disabled",
		"module_unavailable",
		"mutation_blocked",
		"mutation_in_progress",
		"identity_unresolved",
		"recovery_pending",
		"rebaseline_required",
		"device_decommissioned",
		"streaming_active",
	]);
	return known.has(token)
		? `network.modem.gps.error.${token}`
		: "network.modem.gps.error.read_failed";
}
