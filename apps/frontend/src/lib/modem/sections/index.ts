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
 * The public surface of the shared modem section primitives.
 *
 * Both modem dialogs consume THIS module and nothing deeper, so the set of
 * things a dialog can reach is the set of things listed here — which is what
 * makes "the one rendering path" checkable rather than aspirational.
 */

export { default as CapabilitySection } from "./CapabilitySection.svelte";
export { default as ConnectionStateBlock } from "./ConnectionStateBlock.svelte";
export { default as DiagnosticsBlock } from "./DiagnosticsBlock.svelte";
export {
	BASELINE_UNAVAILABLE_KEY,
	DEFAULT_CAPABILITY_REASONS,
	deriveCapabilityView,
	deriveCapabilityViews,
	deriveConnection,
	deriveDiagnostics,
	deriveIdentity,
	deriveModemSections,
	deriveSignal,
	deriveSim,
	deriveUnavailability,
	type ModemSectionInput,
	SIGNAL_UNREADABLE_KEY,
	UNNAMED_NOTE_KEY,
	UNNAMED_TITLE_KEY,
} from "./derive";
export { default as IdentityBlock } from "./IdentityBlock.svelte";
export { default as SignalBlock } from "./SignalBlock.svelte";
export { default as SimBlock } from "./SimBlock.svelte";
export {
	CAPABILITY_STATES,
	type CapabilityControlContext,
	type CapabilityReasonKeys,
	type CapabilityState,
	type CapabilityView,
	type ConnectionModel,
	type DiagnosticRow,
	type DiagnosticsModel,
	type IdentityModel,
	type ModemRowState,
	type ModemRowTone,
	type ModemSectionSet,
	type ModemSignalTier,
	type ResolvedDiagnosticRow,
	type SignalModel,
	type SimModel,
	UNAVAILABILITY_ORIGINS,
	type UnavailabilityNote,
	type UnavailabilityOrigin,
} from "./types";
