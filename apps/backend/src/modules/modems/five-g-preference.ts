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
 * The `five-g-pref` capability module's derivation — PURE, so every rule below is
 * provable with no mmcli on the host.
 *
 * It reads `Modem.radio_modes`, the UNFOLDED `(allowed, preferred)` catalog, and
 * never `network_type.supported`: that map is keyed by allowed-set label, so the
 * two postures this module exists to separate collapse into one entry there.
 *
 * Rule-D MIRROR of modem-stack's `control/src/capability/five-g-preference.ts`,
 * re-derived rather than imported. The vocabularies genuinely differ — mmcli says
 * `2g/3g/4g/5g`, the D-Bus library says `gsm/umts/lte/5gnr` — so this is a
 * translation boundary, and the two halves are kept honest by their tests.
 */

import type { CapabilityEvidence } from "@ceraui/rpc/schemas";
import {
	FIVE_G_PREFERENCES,
	type FiveGPreference,
	type ModemFiveGPreference,
	type NrModeSelection,
} from "@ceraui/rpc/schemas";

import type { NetworkType } from "./mmcli.ts";
import type { Modem } from "./modems-state.ts";

/** mmcli's mode tokens, highest generation first. The ONE ordering used here. */
const MODE_ORDER = ["5g", "4g", "3g", "2g"] as const;
type ModeToken = (typeof MODE_ORDER)[number];

import { modemControlFunction } from "../modem-control-compat.ts";

/**
 * The packaged twin shares this function's NAME and not its SIGNATURE: it takes
 * the already-decoded RAT set, while this module is handed mmcli's `(allowed,
 * preferred)` catalog. The structural probe casts, so a bare delegation
 * type-checks and then throws `supportedRats.has is not a function` at runtime —
 * a name match is not a contract match, and only the adapter below makes the two
 * call-compatible.
 */
type PackagedFiveGPreferenceEvidence = (
	supportedRats: ReadonlySet<string> | undefined,
) => CapabilityEvidence;

const packagedFiveGPreferenceEvidence = modemControlFunction<
	PackagedFiveGPreferenceEvidence | undefined
>("fiveGPreferenceEvidence", undefined);

/** mmcli's generation tokens → the package's RAT vocabulary. */
const PACKAGE_RAT_BY_MODE = {
	"5g": "5gnr",
	"4g": "lte",
	"3g": "umts",
	"2g": "gsm",
} as const satisfies Record<ModeToken, string>;

const FIVE_G: ModeToken = "5g";
const FOUR_G: ModeToken = "4g";

function isModeToken(token: string): token is ModeToken {
	return (MODE_ORDER as readonly string[]).includes(token);
}

/** `"5g|4g|3g"` → the tokens it names, ranked. Unknown tokens are dropped. */
export function parseAllowedModes(allowed: string): readonly ModeToken[] {
	const named = new Set(allowed.split("|").filter(isModeToken));
	return MODE_ORDER.filter((mode) => named.has(mode));
}

/**
 * Every mode family the modem's own catalog names, ranked.
 *
 * A catalog row is a permitted allowed-SET, so the union across rows is what the
 * radio can be asked for at all. `undefined` for an unobserved catalog, which is
 * NOT the same as an empty one — see {@link fiveGPreferenceEvidence}.
 */
export function supportedModes(
	radioModes: Modem["radio_modes"],
): readonly ModeToken[] | undefined {
	if (radioModes === undefined) return undefined;
	const named = new Set<ModeToken>();
	for (const row of radioModes.supported) {
		for (const mode of parseAllowedModes(row.allowed)) named.add(mode);
	}
	return MODE_ORDER.filter((mode) => named.has(mode));
}

/**
 * Whether THIS modem can do 5G at all.
 *
 * An unobserved or empty catalog is `unknown`, never `absent`: a read that never
 * landed says nothing about the device, and the support ladder stops at `enabled`
 * for `unknown` — surfaced by nothing, mutated by nothing. Answering `absent`
 * there would hide the module on hardware that supports it.
 */
export function fiveGPreferenceEvidence(
	radioModes: Modem["radio_modes"],
): CapabilityEvidence {
	const modes = supportedModes(radioModes);
	if (packagedFiveGPreferenceEvidence !== undefined) {
		return packagedFiveGPreferenceEvidence(
			modes === undefined
				? undefined
				: new Set(modes.map((mode) => PACKAGE_RAT_BY_MODE[mode])),
		);
	}
	if (modes === undefined || modes.length === 0) return "unknown";
	return modes.includes(FIVE_G) ? "present" : "absent";
}

/**
 * Which postures this radio advertised.
 *
 * A modem with no 5G is offered NOTHING — not `5g-off` either: "turn 5G off" on a
 * radio that has none is a control that cannot change anything, which is worse
 * than an absent one because it invites an operator to act. The three
 * fallback-bearing postures additionally need a sub-5G family to fall back TO, or
 * all three collapse onto `5g-only`'s allowed set: three labels for one posture.
 */
export function offeredFiveGPreferences(
	radioModes: Modem["radio_modes"],
): readonly FiveGPreference[] {
	const modes = supportedModes(radioModes);
	if (modes === undefined || !modes.includes(FIVE_G)) return [];
	if (modes.length === 1) return ["5g-only"];
	return FIVE_G_PREFERENCES.filter(
		(preference) => preference !== "prefer-4g" || modes.includes(FOUR_G),
	);
}

/**
 * Resolve a stated posture into the mmcli `(allowed, preferred)` pair to write.
 *
 * `undefined` means this radio cannot express it, and the caller must REFUSE
 * rather than substitute a neighbour — substituting is how an operator asks for
 * "prefer 4G" on a marginal cell and silently gets 5G-first.
 *
 * `preferred: "none"` is mmcli's own token for "rank nothing", and
 * `mmSetNetworkTypes` already omits `--set-preferred-mode` for it.
 */
export function fiveGPreferenceToModes(
	preference: FiveGPreference,
	radioModes: Modem["radio_modes"],
): NetworkType | undefined {
	const modes = supportedModes(radioModes);
	if (
		modes === undefined ||
		!offeredFiveGPreferences(radioModes).includes(preference)
	) {
		return undefined;
	}
	const withoutFiveG = modes.filter((mode) => mode !== FIVE_G);

	switch (preference) {
		case "5g-only":
			return { allowed: FIVE_G, preferred: "none" };
		case "prefer-5g":
			return { allowed: modes.join("|"), preferred: FIVE_G };
		case "prefer-4g":
			// The ALLOWED set is byte-identical to `prefer-5g`'s — only the ranking
			// moves. That is the posture, and it is why nothing on this path may
			// decide "no write is needed" by diffing allowed sets.
			return { allowed: modes.join("|"), preferred: FOUR_G };
		case "5g-off":
			return { allowed: withoutFiveG.join("|"), preferred: "none" };
	}
}

/**
 * Which posture the radio's CURRENT pair names — or `null` for a pair no posture
 * describes.
 *
 * `null` is first-class and must not be rounded: a radio parked on
 * `allowed: 3g,4g; preferred: 3g` is in a state no 5G posture names, and reporting
 * one would show an operator a selection they never made and cannot return to.
 */
export function readFiveGPreference(
	radioModes: Modem["radio_modes"],
): FiveGPreference | null {
	const current = radioModes?.current;
	if (current === undefined) return null;
	const allowed = parseAllowedModes(current.allowed);
	if (allowed.length === 0) return null;

	if (!allowed.includes(FIVE_G)) return "5g-off";
	if (allowed.length === 1) return "5g-only";
	if (current.preferred === FIVE_G) return "prefer-5g";
	if (current.preferred === FOUR_G) return "prefer-4g";
	return null;
}

/**
 * SA vs NSA. ModemManager exposes no standalone-vs-non-standalone selector at
 * all — the only NR-specific member on a modem object is
 * `Modem3gpp.SetNr5gRegistrationSettings`, whose keys are `mico-mode` and
 * `drx-cycle` (power-saving registration parameters). Vendors expose the choice
 * through per-SKU AT commands; this build opens none of them, because an
 * uncertified AT write that can cost registration is exactly what the evidence
 * gate keeps out.
 *
 * It is STATED rather than omitted so an operator hunting for an SA toggle is
 * told why there is none.
 */
export function nrModeSelection(): NrModeSelection {
	return { supported: false, reason: "not-exposed-by-modemmanager" };
}

/** The module's whole READ half for one modem. */
export function buildFiveGPreferenceView(
	radioModes: Modem["radio_modes"],
): ModemFiveGPreference {
	return {
		offered: [...offeredFiveGPreferences(radioModes)],
		active: readFiveGPreference(radioModes),
		nr_mode: nrModeSelection(),
	};
}
