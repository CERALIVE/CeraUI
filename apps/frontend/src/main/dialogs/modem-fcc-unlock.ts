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

import {
	type CapabilityReasonKeys,
	resolveCapabilityRender,
} from "../network/capability-modules";

export type FccUnlockView =
	/** CT-1: positively unsupported or not shipped — ZERO DOM nodes. */
	| { readonly kind: "absent" }
	/** CT-3: nothing established about this modem — a distinct diagnostic, no control. */
	| { readonly kind: "unknown"; readonly reasonKey: string }
	/** CT-2: supported, refused right now — the control renders DISABLED with this reason. */
	| { readonly kind: "blocked"; readonly reasonKey: string }
	| {
			readonly kind: "toggle";
			readonly enabled: boolean;
			/** The `<vid>:<pid>` the symlink would be named after. */
			readonly key: string;
	  };

const REASONS: CapabilityReasonKeys = {
	moduleDisabled: "network.modem.fccUnlock.reason.moduleDisabled",
	unproven: "network.modem.fccUnlock.reason.unproven",
};

/**
 * Resolve what to render for one modem.
 *
 * The claim ladder is NOT re-derived here — it routes through the shared
 * `resolveCapabilityRender`, so this surface and every other capability surface
 * answer one question one way. What is local is only the CURRENT refusal: a
 * covered model that answered with no key, and a model ModemManager has no
 * procedure for, are both ≥`capable` modules the device is refusing right now,
 * which is the disabled-with-reason class (CT-2) rather than a hidden one.
 */
export function fccUnlockView(
	claim: SupportClaimState | undefined,
	state: FccUnlockState | undefined,
): FccUnlockView {
	const view = resolveCapabilityRender(
		claim,
		REASONS,
		fccCurrentRefusalKey(state),
	);
	switch (view.mode) {
		case "absent":
			return { kind: "absent" };
		case "unknown":
			return { kind: "unknown", reasonKey: view.reasonKey };
		case "blocked":
			return { kind: "blocked", reasonKey: view.reasonKey };
		case "available":
			return state?.key === undefined
				? { kind: "unknown", reasonKey: REASONS.unproven }
				: { kind: "toggle", enabled: state.enabled, key: state.key };
	}
}

function fccCurrentRefusalKey(
	state: FccUnlockState | undefined,
): string | undefined {
	if (state === undefined || state.key === undefined) return REASONS.unproven;
	if (state.coverage !== "present") {
		return "network.modem.fccUnlock.reason.notCovered";
	}
	return undefined;
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
