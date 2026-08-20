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
 * The live evidence reader behind `capability-gates.ts`'s seam — where each
 * IMPLEMENTED capability module's probe is registered.
 *
 * `capability-gates.ts` deliberately ships an EMPTY default, so every modem
 * resolves every module `unavailable` until a module lands its own probe here.
 * That is what stops a config gate surfacing a control with nothing behind it,
 * and it is why a module is added to `IMPLEMENTED_CAPABILITY_MODULES` in the same
 * change as its probe and never before.
 *
 * Implemented so far: `five-g-pref`, `band-lock`, `gps`, `ussd`.
 */

import type { CapabilityEvidence, CapabilityModule } from "@ceraui/rpc/schemas";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import { bandLockEvidence, isBandLockCertified } from "./band-capability.ts";
import {
	type ModemCapabilityEvidence,
	setModemCapabilityEvidenceReader,
} from "./capability-gates.ts";
import { fccUnlockEvidence } from "./fcc-unlock.ts";
import { fiveGPreferenceEvidence } from "./five-g-preference.ts";
import { gpsEvidence } from "./gps.ts";
import { getModemIdPath } from "./modem-wire-producer.ts";
import { getModems, type Modem } from "./modems-state.ts";
import { ussdEvidence } from "./ussd.ts";

/**
 * The modules whose probe is wired below, and therefore the list this build may
 * be told it implements. A module absent here resolves `unavailable`, which is
 * what stops a config gate from surfacing a control with nothing behind it.
 */
export const IMPLEMENTED_MODEM_CAPABILITY_MODULES: readonly CapabilityModule[] =
	["five-g-pref", "band-lock", "gps", "ussd"];

/**
 * The modem behind a `stable_key`, or `undefined`.
 *
 * Resolved by re-deriving each live modem's key from the SAME `ID_PATH` cache and
 * the SAME `deriveModemStableKey` rule the wire producer uses, so the row an
 * operator is looking at and the row a probe answers about cannot be different
 * devices. A modem with no resolvable `ID_PATH` is unreachable here by design —
 * it has no key to be asked about, and the mutation lease refuses it too.
 */
function modemForStableKey(stableKey: string | undefined): Modem | undefined {
	if (stableKey === undefined || stableKey === "") return undefined;
	for (const modem of Object.values(getModems())) {
		const idPath = getModemIdPath(modem.ifname);
		if (idPath !== undefined && deriveModemStableKey(idPath) === stableKey) {
			return modem;
		}
	}
	return undefined;
}

export function readModemCapabilityEvidence(
	stableKey: string | undefined,
): ModemCapabilityEvidence {
	const modem = modemForStableKey(stableKey);
	const capability: Partial<Record<CapabilityModule, CapabilityEvidence>> = {
		// A modem this reader cannot find is `unknown`, never `absent`: failing to
		// resolve a key is a statement about the LOOKUP, and the ladder stops at
		// `enabled` for `unknown` — surfaced by nothing, mutated by nothing.
		"five-g-pref": fiveGPreferenceEvidence(modem?.radio_modes),
		// Band-lock's probe is a CACHED mmcli read rather than a live-state field:
		// the wire build is synchronous, so `band-capability.ts` refreshes a
		// snapshot from the band RPCs and this serves it. A modem nothing has read
		// yet answers `unknown`, which is the same "we have not looked" the row
		// above documents.
		"band-lock": bandLockEvidence(stableKey),
		// FCC-unlock evidence CANNOT come from the modem — the procedure is a
		// ModemManager dispatcher keyed on the device, and nothing the radio itself
		// reports says whether one applies. So it comes from the CATALOG, read off
		// the same USB descriptors the classifier and the identity resolver use.
		"fcc-auto-unlock": fccUnlockEvidence(modem?.ifname),
		// Same cached-read shape as band-lock, for the same synchronous-wire-build
		// reason. It is refreshed by the GPS RPCs — the surface the operator's UI
		// asks first — and a modem nothing has read yet answers `unknown`, never
		// `absent`: not having looked is not evidence of a missing receiver.
		gps: gpsEvidence(stableKey),
		// Same cached-read shape again. A modem nothing has read yet answers
		// `unknown`; only a positive mmcli "no USSD support" writes `absent`, so a
		// failed read can never hide a modem that does carry the interface.
		ussd: ussdEvidence(stableKey),
	};
	// Certification gates what may be CLAIMED for every other module; for
	// band-lock it additionally gates what may be OFFERED. See
	// `band-capability.ts` for why this one module is stricter than the floor.
	return {
		capability,
		certified: { "band-lock": isBandLockCertified(stableKey) },
	};
}

export function initModemCapabilityEvidence(): void {
	setModemCapabilityEvidenceReader(readModemCapabilityEvidence);
}

// Installed at MODULE SCOPE rather than from a boot call site, the
// `usb-mode-rollback.ts` precedent. Every module's gate resolves through this
// reader, so a boot step that gets dropped in a refactor would not fail loudly —
// it would silently answer `unknown` for every probe, leaving every control
// withheld with no error anywhere. The exported initializer stays for tests that
// reset the seam and need to put the live reader back.
initModemCapabilityEvidence();
