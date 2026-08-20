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
 * What the FCC auto-unlock section renders, as pure data.
 *
 * The whole reason this is a module rather than markup inside the dialog is that
 * the interesting decision — WHEN the model-wide disclosure must be shown — is a
 * rule, and a rule stated once in a `.ts` file can be tested against every input
 * class without mounting anything.
 */

import type { FccUnlockState, SupportClaimState } from "@ceraui/rpc/schemas";

export type FccUnlockView =
	| { readonly kind: "hidden" }
	| {
			readonly kind: "blocked";
			/** Why the control cannot be used, as an i18n key. */
			readonly reasonKey: string;
	  }
	| {
			readonly kind: "toggle";
			readonly enabled: boolean;
			/** The `<vid>:<pid>` the symlink would be named after. */
			readonly key: string;
	  };

/**
 * Resolve what to render for one modem.
 *
 * The ordering is the contract:
 *
 * 1. `unavailable` HIDES the section. That state means this build does not ship
 *    the module OR ModemManager positively has no procedure for this model — and
 *    on a fleet where 7 of 8 devices are uncovered, a permanent disabled row on
 *    every one of them is noise, not honesty. The operator can act on neither.
 * 2. `implemented` is BLOCKED-with-a-reason, not hidden. The device-config gate
 *    is off and turning it on is the fix, so the operator must be able to see the
 *    control exists — the same distinction `module_disabled` vs
 *    `module_unavailable` draws on the write side.
 * 3. `enabled` is also blocked: the gate is on but the coverage READ failed, so
 *    nothing here can be shown to work. Offering a toggle on an unproven
 *    capability is exactly what the capability floor exists to prevent.
 * 4. `capable`/`certified` render the toggle — but only once the device answered
 *    with a key. A state with no key has nothing to name a symlink after.
 */
export function fccUnlockView(
	claim: SupportClaimState | undefined,
	state: FccUnlockState | undefined,
): FccUnlockView {
	if (claim === undefined || claim === "unavailable") {
		return { kind: "hidden" };
	}
	if (claim === "implemented") {
		return {
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.moduleDisabled",
		};
	}
	if (claim === "enabled") {
		return {
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.unproven",
		};
	}
	if (state === undefined || state.key === undefined) {
		return {
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.unproven",
		};
	}
	if (state.coverage !== "present") {
		return {
			kind: "blocked",
			reasonKey: "network.modem.fccUnlock.reason.notCovered",
		};
	}
	return { kind: "toggle", enabled: state.enabled, key: state.key };
}

/**
 * The i18n key for a `setFccUnlock` failure.
 *
 * A raw machine token is never rendered — same rule the rest of the modem surface
 * follows — and an UNMAPPED token falls back to the generic failure line rather
 * than leaking itself into operator copy.
 */
export function fccUnlockErrorKey(token: string): string {
	const known = new Set([
		"unknown_modem",
		"identity_unknown",
		"not_covered",
		"write_failed",
		"unavailable_in_emulated_mode",
		"streaming_active",
		"module_disabled",
		"module_unavailable",
		"mutation_blocked",
		"mutation_in_progress",
		"identity_unresolved",
		"recovery_pending",
		"rebaseline_required",
		"device_decommissioned",
	]);
	return known.has(token)
		? `network.modem.fccUnlock.error.${token}`
		: "network.modem.fccUnlock.error.write_failed";
}
