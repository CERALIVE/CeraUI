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
 * THE ONE RENDERING PATH — the shared vocabulary both modem dialogs speak.
 *
 * Every device this UI lists reaches the operator through the primitives in this
 * directory, and NOTHING in here may ask what KIND of device it is. There is no
 * vendor test, no transport test, no model test and no family test anywhere
 * under `lib/modem/sections/`; a static gate greps the comment-stripped source
 * and fails on the attempt. That is not a style rule — it is the mechanism
 * behind "one control surface": two dialogs that each decide for themselves what
 * a device deserves are two vocabularies, and an operator comparing two rows on
 * one screen is the person who pays for the difference.
 *
 * ── THE FOUR-STATE CONTRACT ─────────────────────────────────────────────────
 *
 * The four states are NOT redefined here. They are the ones the capability
 * framework already resolves (`main/network/capability-modules.ts`), re-exported
 * under this directory's own names so there is exactly ONE ladder in the
 * frontend and a second derivation is unexpressible:
 *
 *   absent    — positively unsupported, or not shipped. ZERO DOM nodes. Not a
 *               ghost row, not a tooltip, not a greyed placeholder.
 *   unknown   — nothing has been established. A visibly distinct `role="status"`
 *               diagnostic and NO CONTROL, disabled or otherwise: below `capable`
 *               nobody has shown there is a capability to withhold, and a
 *               disabled control claims there is.
 *   blocked   — supported, refused right now. The control renders DISABLED with
 *               its reason ON SCREEN — never in a `title` alone, because the
 *               shipped kiosk touchscreen cannot hover to reveal one.
 *   available — the control renders, live.
 *
 * ── THE GUARANTEED MINIMUM BASELINE ─────────────────────────────────────────
 *
 * Separately from any capability, EVERY device — including one this build does
 * not recognise at all — renders a complete card:
 *
 *   1. IDENTITY ALWAYS RENDERS. {@link IdentityModel.title} is empty only when
 *      the device published no name, no slot and no interface name, and even
 *      then {@link IdentityModel.titleKey} carries an honest stand-in. There is
 *      no input for which the identity block renders nothing.
 *   2. WHATEVER TELEMETRY IS READABLE RENDERS, and nothing else. An absent
 *      reading is stated as absent — never a dash, never a zero, never an empty
 *      meter, all three of which read as a measurement that was taken.
 *   3. AN UNUSABLE DEVICE SAYS SO, WITH A REASON. {@link ModemSectionSet.unavailability}
 *      is non-empty whenever the row would otherwise state nothing at all, so a
 *      card can never be mute. See `derive.ts` for the exact floor.
 *
 * Together those three are why there is never an empty card, never a layout
 * break, and never a claimed capability.
 */

import type {
	ModemRowState,
	ModemRowTone,
	ModemSignalTier,
} from "$main/network/cellular-row";

/**
 * The four states, and the resolver behind them, re-exported VERBATIM.
 *
 * Aliasing rather than restating is deliberate: `CapabilityState` and
 * `CapabilityRenderMode` are the same four strings, and a local copy of the
 * union would be free to drift from the resolver that produces it. A caller that
 * has a claim resolves it through `deriveCapabilityView` in `derive.ts`; a
 * caller that already holds a view passes it straight to `CapabilitySection`.
 */
export {
	CAPABILITY_RENDER_MODES as CAPABILITY_STATES,
	type CapabilityReasonKeys,
	type CapabilityRenderMode as CapabilityState,
	type CapabilityRenderView as CapabilityView,
} from "$main/network/capability-modules";
export type {
	ModemRowState,
	ModemRowTone,
	ModemSignalTier,
} from "$main/network/cellular-row";

/**
 * What a caller's control snippet is told, so the SAME snippet serves both
 * states it may render in.
 *
 * `ModemGpsSection` and `ModemFccUnlockSection` each wrote their switch once and
 * flipped `disabled` on it; this generalises that rather than asking a caller to
 * author two controls that must then be kept identical by hand.
 */
export interface CapabilityControlContext {
	/** True at `blocked`, and true at `available` while a write is in flight. */
	readonly disabled: boolean;
	/** Never `unknown` or `absent` — no control is rendered in either. */
	readonly state: "available" | "blocked";
	/** The already-resolved refusal sentence. Absent at `available`. */
	readonly reason?: string;
	/** DOM id of the on-screen reason, for the control's `aria-describedby`. */
	readonly reasonId?: string;
}

/**
 * WHICH DEVICE this is.
 *
 * `title` holds whatever the device published, in the precedence
 * `primaryLabel` already applies, with the interface name as the last resort —
 * an interface name is a real identity and is far better than a placeholder.
 * `titleKey` is set ONLY when even that is empty, so a caller never has to
 * decide between the two: render `title` when it is non-empty, otherwise resolve
 * `titleKey`.
 *
 * `identified` is a separate fact from a non-empty title: a row falling back to
 * its interface name has a title AND is unidentified, and the block says so
 * rather than presenting a kernel name as the operator's device name.
 */
export interface IdentityModel {
	readonly title: string;
	/** Set only when `title` is empty. Never both. */
	readonly titleKey?: string;
	/** Did the device publish a NAME or a SLOT of its own? */
	readonly identified: boolean;
	readonly slotLabel?: string;
	readonly detail?: string;
	/** How this device is reached, in the operator's terms — never a token. */
	readonly classHintKey: string;
}

/** WHAT IT IS DOING. One word, one glyph, one register — colour reinforces. */
export interface ConnectionModel {
	readonly state: ModemRowState;
	readonly tone: ModemRowTone;
	readonly labelKey: string;
	/** The network the radio is actually on, when it stated one. */
	readonly carrier?: string;
	/** The modem's own registration claim, never the operator's permission. */
	readonly roaming: boolean;
	/** Why the network is refusing it, when the network said so. */
	readonly rejectionKey?: string;
}

/**
 * HOW THE RADIO IS — or an honest statement that nothing is readable.
 *
 * `provenance` names the INSTRUMENT rather than the device: `device-stack` is
 * this board's own modem service, `device-admin` is a reading the device
 * published about itself. Those are different instruments and a surface showing
 * one must be able to say which it has — but naming them by instrument rather
 * than by dialect is what keeps this directory family-blind.
 */
export type SignalModel =
	| {
			readonly readable: true;
			readonly tier: ModemSignalTier;
			readonly tierKey: string;
			readonly provenance: "device-stack" | "device-admin";
			/** A carried-over reading, re-served after a missed cycle. */
			readonly stale: boolean;
	  }
	| { readonly readable: false; readonly reasonKey: string };

/**
 * WHETHER THERE IS A CARD IN IT.
 *
 * `unknown` is a fourth value rather than an optimistic `present`: the two modem
 * classes publish slot state through different wire fields and a device may
 * publish neither, so "we were not told" is its own answer.
 */
export type SimModel =
	| { readonly presence: "absent" }
	| { readonly presence: "locked"; readonly lock: string }
	| { readonly presence: "present" }
	| { readonly presence: "unknown" };

/**
 * One raw reading, in the device's OWN spelling.
 *
 * Values are passed through verbatim: a diagnostics value that has been tidied
 * is no longer the thing a field engineer compares against a vendor table. This
 * is the ONLY block a raw token may reach, which is what lets every operator
 * surface stay clean without deleting anything (`DESIGN.md` §3 OL-3).
 */
export interface DiagnosticRow {
	readonly id: string;
	readonly labelKey: string;
	readonly value: string;
}

/**
 * A pre-resolved diagnostics row, for a caller whose label table already
 * returned operator strings rather than keys.
 */
export interface ResolvedDiagnosticRow {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly note?: string;
}

export interface DiagnosticsModel {
	readonly rows: readonly DiagnosticRow[];
}

/**
 * One reason this row cannot be acted on, already de-duplicated against its
 * siblings by the row's own authority.
 *
 * `id` names WHERE the reason came from, so a caller can key an `{#each}` and a
 * gate can assert a specific one is present without matching on copy.
 */
export interface UnavailabilityNote {
	readonly id: UnavailabilityOrigin;
	readonly reasonKey: string;
}

export const UNAVAILABILITY_ORIGINS = [
	"rejection",
	"availability",
	"bond",
	"configure",
	"baseline",
] as const;
export type UnavailabilityOrigin = (typeof UNAVAILABILITY_ORIGINS)[number];

/** The complete render model for one device. Every field is always present. */
export interface ModemSectionSet {
	readonly identity: IdentityModel;
	readonly connection: ConnectionModel;
	readonly signal: SignalModel;
	readonly sim: SimModel;
	readonly diagnostics: DiagnosticsModel;
	/**
	 * NON-EMPTY whenever the row would otherwise say nothing about why it cannot
	 * be used. That is the third leg of the guaranteed minimum baseline, and it
	 * is what makes "never an empty card" a property rather than a hope.
	 */
	readonly unavailability: readonly UnavailabilityNote[];
}
