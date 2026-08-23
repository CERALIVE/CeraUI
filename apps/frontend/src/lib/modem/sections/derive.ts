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
 * One normalized modem row → the section set both dialogs render. Pure,
 * rune-free and locale-free: every string that reaches an operator leaves here
 * as an i18n DOT-PATH KEY, exactly as `cellular-row.ts` does, so this rule can
 * be driven against every input class without mounting anything and without a
 * locale loaded.
 *
 * ── THIS FILE DERIVES NOTHING TWICE ─────────────────────────────────────────
 *
 * Every verdict below is READ from an existing authority and re-shaped, never
 * recomputed:
 *
 *   · the class band, lifecycle state, action, tones, labels, rejection copy,
 *     bond/configure refusals and the note de-duplication all come from
 *     `main/network/cellular-row.ts`;
 *   · the device-published radio reading comes from `main/network/router-signal.ts`;
 *   · the four-state capability ladder comes from
 *     `main/network/capability-modules.ts`.
 *
 * A second copy of any of them would be free to disagree with the surface that
 * already ships it, and every way it could disagree is a lie to an operator: a
 * control offered where the device refuses, a refusal shown where the device
 * would have obliged, or two rows describing one condition differently.
 *
 * ── AND IT ASKS NOTHING ABOUT WHAT KIND OF DEVICE IT IS ─────────────────────
 *
 * There is no vendor, transport, model or family test anywhere in this file. The
 * class band is computed once and handed STRAIGHT to the functions that need it;
 * it is never compared against a literal here. The only branches are on what the
 * device actually published — which is the same question for every device.
 */

import type {
	CapabilityModule,
	CapabilityModuleClaims,
	Modem,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { CAPABILITY_MODULES } from "@ceraui/rpc/schemas";

import {
	type CapabilityReasonKeys,
	resolveCapabilityRender,
} from "$main/network/capability-modules";
import {
	activeSimLock,
	availabilityReasonKey,
	bondDisabledReasonKey,
	carrierLabel,
	classHintKey,
	configureDisabledReasonKey,
	detailLine,
	isRoamingActive,
	isSimlessModem,
	type ModemClassBand,
	type ModemRowState,
	primaryLabel,
	registrationRejectionKey,
	resolveClassBand,
	resolveRowState,
	resolveSignalTier,
	rowNoteKeys,
	signalLabelKey,
	slotBadgeLabel,
	stateLabelKey,
	stateTone,
} from "$main/network/cellular-row";
import {
	isStaleReadout,
	resolveRouterSignalReadout,
	routerSignalReasonKey,
} from "$main/network/router-signal";

import type {
	CapabilityView,
	ConnectionModel,
	DiagnosticRow,
	DiagnosticsModel,
	IdentityModel,
	ModemSectionSet,
	SignalModel,
	SimModel,
	UnavailabilityNote,
	UnavailabilityOrigin,
} from "./types";

/**
 * The stand-in title for a device that published no name, no slot AND no
 * interface name. It is deliberately a KEY rather than an empty string: a card
 * with a blank heading is the empty card this baseline exists to forbid.
 */
export const UNNAMED_TITLE_KEY = "network.modem.sections.identity.unnamed";

/** Said whenever the device itself published no name of its own. */
export const UNNAMED_NOTE_KEY = "network.modem.sections.identity.unnamedNote";

/** No instrument on this device published a radio reading we can render. */
export const SIGNAL_UNREADABLE_KEY = "network.modem.sections.signal.unreadable";

/**
 * THE FLOOR OF THE GUARANTEED MINIMUM BASELINE.
 *
 * Emitted only when a row would otherwise state nothing at all — no reading, no
 * lifecycle state, and no reason of the device's own. Without it an unrecognised
 * device renders identity and then silence, which an operator reads as a broken
 * card rather than as an honest "we were told nothing".
 */
export const BASELINE_UNAVAILABLE_KEY =
	"network.modem.sections.unavailable.baseline";

/**
 * The generic pair for a capability section whose own surface has no copy of its
 * own yet. A module that DOES have its own sentences (location, FCC unlock)
 * keeps them — this is the floor, not a replacement.
 */
export const DEFAULT_CAPABILITY_REASONS: CapabilityReasonKeys = {
	moduleDisabled: "network.modem.sections.capability.moduleDisabled",
	unproven: "network.modem.sections.capability.unproven",
};

const DIAGNOSTIC_LABEL_KEYS = {
	interface: "network.modem.sections.diagnostics.interface",
	transport: "network.modem.sections.diagnostics.transport",
	availability: "network.modem.sections.diagnostics.availability",
	packetService: "network.modem.sections.diagnostics.packetService",
	stableKey: "network.modem.sections.diagnostics.stableKey",
	adminLogin: "network.modem.sections.diagnostics.lockState",
	usbComposition: "network.modem.detail.diagnosticsUsbMode",
	firmware: "network.modem.detail.firmware",
	simId: "network.modem.detail.iccid",
} as const;

export interface ModemSectionInput {
	readonly modem: Modem;
	/**
	 * Whether this row's interface currently holds an address.
	 *
	 * OMITTED means "we were not told", and the bond refusal is then SKIPPED
	 * entirely rather than defaulted — claiming a link cannot bond on the
	 * strength of a fact nobody supplied is the fabrication this whole surface
	 * exists to prevent. A caller that knows (both dialogs do, from `netif`)
	 * passes it and gets the device's real refusal.
	 */
	readonly hasAddress?: boolean;
}

/**
 * The complete render model for one device.
 *
 * TOTAL by construction: every field of {@link ModemSectionSet} is populated for
 * every input, including a row carrying nothing but an interface name. There is
 * no input for which this returns a partial set and no input for which it
 * throws — the unrecognised-device case is the DESIGN POINT, not an edge.
 */
export function deriveModemSections(input: ModemSectionInput): ModemSectionSet {
	const { modem } = input;
	const band = resolveClassBand(modem.device_class);
	const state = resolveRowState(modem, band);

	const identity = deriveIdentity(modem, band);
	const connection = deriveConnection(modem, state);
	const signal = deriveSignal(modem);
	const sim = deriveSim(modem);
	const diagnostics = deriveDiagnostics(modem);
	const unavailability = deriveUnavailability({
		modem,
		band,
		state,
		signal,
		connection,
		...(input.hasAddress === undefined ? {} : { hasAddress: input.hasAddress }),
	});

	return { identity, connection, signal, sim, diagnostics, unavailability };
}

/**
 * IDENTITY ALWAYS RENDERS.
 *
 * The interface name is the last resort BEFORE the stand-in key, because it is a
 * genuine identity an operator can act on (it is what every other network
 * surface on this device calls the same link) — but a row that fell back to it
 * is still `identified: false`, so the block can say the device named itself
 * nothing rather than presenting a kernel name as a product name.
 */
export function deriveIdentity(
	modem: Modem,
	band: ModemClassBand,
): IdentityModel {
	const title = primaryLabel(modem, modem.ifname);
	const identified =
		(modem.name?.trim() ?? "") !== "" ||
		(modem.slot_label?.trim() ?? "") !== "";
	const slotLabel = slotBadgeLabel(modem, title);
	const detail = detailLine(modem, title);

	return {
		title,
		...(title === "" ? { titleKey: UNNAMED_TITLE_KEY } : {}),
		identified,
		...(slotLabel === undefined ? {} : { slotLabel }),
		...(detail === undefined ? {} : { detail }),
		classHintKey: classHintKey(band),
	};
}

export function deriveConnection(
	modem: Modem,
	state: ModemRowState,
): ConnectionModel {
	const carrier = carrierLabel(modem);
	const rejectionKey = registrationRejectionKey(modem);

	return {
		state,
		tone: stateTone(state),
		labelKey: stateLabelKey(state),
		...(carrier === undefined ? {} : { carrier }),
		roaming: isRoamingActive(modem),
		...(rejectionKey === undefined ? {} : { rejectionKey }),
	};
}

/**
 * WHATEVER TELEMETRY IS READABLE, and nothing else.
 *
 * The two instruments are mutually exclusive per row by construction, so this is
 * a preference rather than a merge: whichever one published a reading is the one
 * rendered, and when neither did the model says so in words. Absence is never a
 * dash, a zero or an empty meter — all three read as a measurement that was
 * taken and came back at the bottom of the scale.
 */
export function deriveSignal(modem: Modem): SignalModel {
	const tier = resolveSignalTier(modem.status?.signal);
	if (tier !== undefined) {
		return {
			readable: true,
			tier,
			tierKey: signalLabelKey(tier),
			provenance: "device-stack",
			stale: false,
		};
	}

	const readout = resolveRouterSignalReadout(modem);
	if (readout === undefined) {
		return { readable: false, reasonKey: SIGNAL_UNREADABLE_KEY };
	}
	if (readout.kind === "reading") {
		return {
			readable: true,
			tier: readout.tier,
			tierKey: signalLabelKey(readout.tier),
			provenance: "device-admin",
			stale: isStaleReadout(readout),
		};
	}
	// An empty slot is the SIM block's fact, and it is stated there. Repeating it
	// as a signal reason would put the same condition on screen twice.
	if (readout.kind === "no-sim") {
		return { readable: false, reasonKey: SIGNAL_UNREADABLE_KEY };
	}
	return { readable: false, reasonKey: routerSignalReasonKey(readout.reason) };
}

/**
 * WHETHER THERE IS A CARD IN IT — the device's own evidence, then the bond claim.
 *
 * `sim_presence` is the reading `no_sim` is FOLDED from, and it is preferred
 * whenever the device published it. The fold is binary because BONDING is binary
 * — a link either may join the pool or may not — so it resolves `absent` and
 * `unknown` onto one `true`, and a modem with no NetworkManager profile and an
 * unreadable slot arrives here claiming no SIM. Rendering that as `absent` is the
 * unknown-as-absent lie this block exists to refuse.
 *
 * The `no_sim` path below stays the fallback for a backend publishing only the
 * fold, and is the ONLY path a `router-ethernet` dongle takes — that class has no
 * slot reading of its own and is answered by `router_admin.sim` as before. This
 * is a SECOND, richer READING of the same wire and never a second authority over
 * it: `isSimlessModem` still drives the gate, the toggle and the primary banner.
 */
export function deriveSim(modem: Modem): SimModel {
	const stated = modem.sim_presence;

	if (stated === "absent") return { presence: "absent" };
	if (stated === undefined && isSimlessModem(modem)) {
		return { presence: "absent" };
	}

	const lock = activeSimLock(modem);
	if (lock !== undefined) return { presence: "locked", lock };

	if (stated !== undefined) {
		return stated === "present"
			? { presence: "present" }
			: { presence: "unknown" };
	}

	// Positive evidence only. `no_sim === false` is a device stating the slot is
	// populated; anything else is a device that did not say.
	if (modem.no_sim === false) return { presence: "present" };
	if (modem.router_admin?.sim !== undefined) return { presence: "present" };
	if (modem.iccid !== undefined) return { presence: "present" };

	return { presence: "unknown" };
}

/**
 * THE ONLY BLOCK A RAW TOKEN MAY REACH.
 *
 * Values are the device's own, verbatim and unformatted. A field the device did
 * not state produces NO ROW — a dash here would read as "the device reported
 * nothing for this", which is a different claim from "this device has no such
 * field", and neither block is entitled to make the wrong one.
 */
export function deriveDiagnostics(modem: Modem): DiagnosticsModel {
	const candidates: ReadonlyArray<{
		id: string;
		labelKey: string;
		value: string | undefined;
	}> = [
		{
			id: "interface",
			labelKey: DIAGNOSTIC_LABEL_KEYS.interface,
			value: modem.ifname,
		},
		{
			id: "transport",
			labelKey: DIAGNOSTIC_LABEL_KEYS.transport,
			value: modem.device_class,
		},
		{
			id: "availability",
			labelKey: DIAGNOSTIC_LABEL_KEYS.availability,
			value: modem.availability_reason,
		},
		{
			id: "packet-service",
			labelKey: DIAGNOSTIC_LABEL_KEYS.packetService,
			value: modem.packet_service_state,
		},
		{
			id: "usb-composition",
			labelKey: DIAGNOSTIC_LABEL_KEYS.usbComposition,
			value: modem.usb_mode,
		},
		{
			id: "firmware",
			labelKey: DIAGNOSTIC_LABEL_KEYS.firmware,
			value: modem.firmware_revision,
		},
		{ id: "sim-id", labelKey: DIAGNOSTIC_LABEL_KEYS.simId, value: modem.iccid },
		{
			id: "stable-key",
			labelKey: DIAGNOSTIC_LABEL_KEYS.stableKey,
			value: modem.stable_key,
		},
		{
			id: "admin-login",
			labelKey: DIAGNOSTIC_LABEL_KEYS.adminLogin,
			value: modem.lock_state,
		},
	];

	const rows: DiagnosticRow[] = [];
	for (const candidate of candidates) {
		const value = candidate.value?.trim();
		if (value === undefined || value === "") continue;
		rows.push({ id: candidate.id, labelKey: candidate.labelKey, value });
	}
	return { rows };
}

/**
 * EVERY REASON THIS ROW CANNOT BE ACTED ON, plus the floor that guarantees at
 * least one when the row would otherwise be mute.
 *
 * The ORDER, the de-duplication and the supersede rule are `rowNoteKeys`' — this
 * only maps each surviving key back to where it came from, so a caller can key
 * an `{#each}` and a gate can name a specific note without matching on copy.
 */
export function deriveUnavailability(input: {
	readonly modem: Modem;
	readonly band: ModemClassBand;
	readonly state: ModemRowState;
	readonly signal: SignalModel;
	readonly connection: ConnectionModel;
	readonly hasAddress?: boolean;
}): readonly UnavailabilityNote[] {
	const { modem, band, state, signal, connection, hasAddress } = input;

	const rejection = registrationRejectionKey(modem);
	const availability = availabilityReasonKey(modem.availability_reason);
	const bond =
		hasAddress === undefined
			? undefined
			: bondDisabledReasonKey(modem, band, state, hasAddress);
	const configure = configureDisabledReasonKey(band, modem);

	const origins: ReadonlyArray<
		readonly [UnavailabilityOrigin, string | undefined]
	> = [
		["rejection", rejection],
		["availability", availability],
		["bond", bond],
		["configure", configure],
	];

	const surviving = rowNoteKeys({ rejection, availability, bond, configure });
	const notes: UnavailabilityNote[] = surviving.map((reasonKey) => {
		const origin = origins.find(([, key]) => key === reasonKey);
		return { id: origin?.[0] ?? "baseline", reasonKey };
	});

	if (notes.length === 0 && !statesSomething(signal, connection)) {
		notes.push({ id: "baseline", reasonKey: BASELINE_UNAVAILABLE_KEY });
	}
	return notes;
}

/**
 * Did this row learn ANYTHING about the device beyond its existence?
 *
 * A readable reading or a lifecycle state the device actually reported both
 * count. `unknown` does not — it is precisely "nothing was reported", which is
 * the condition the baseline floor exists to explain rather than to leave on
 * screen as a bare word.
 */
function statesSomething(
	signal: SignalModel,
	connection: ConnectionModel,
): boolean {
	return signal.readable || connection.state !== "unknown";
}

/**
 * Resolve ONE capability's four-state view.
 *
 * A thin, deliberate pass-through to the shared resolver: it exists so this
 * directory has a single import surface and so the generic reason pair is the
 * default rather than something each caller re-types. It adds no rule of its
 * own, which is the point — there is one ladder in the frontend.
 */
export function deriveCapabilityView(
	claim: SupportClaimState | undefined,
	reasons: CapabilityReasonKeys = DEFAULT_CAPABILITY_REASONS,
	blockedReasonKey?: string,
): CapabilityView {
	return resolveCapabilityRender(claim, reasons, blockedReasonKey);
}

/**
 * Every module's view in one call, in `CAPABILITY_MODULES`' own order.
 *
 * TOTAL over the module list, so a dialog cannot silently omit a section by
 * forgetting a key, and a payload from a backend that publishes no matrix
 * resolves every module to `absent` — fail-CLOSED, because absence of a claim
 * is not a claim.
 */
export function deriveCapabilityViews(
	claims: CapabilityModuleClaims | undefined,
	options?: {
		readonly reasons?: Partial<Record<CapabilityModule, CapabilityReasonKeys>>;
		readonly blocked?: Partial<Record<CapabilityModule, string>>;
	},
): Record<CapabilityModule, CapabilityView> {
	const views = {} as Record<CapabilityModule, CapabilityView>;
	for (const module of CAPABILITY_MODULES) {
		views[module] = deriveCapabilityView(
			claims?.[module],
			options?.reasons?.[module] ?? DEFAULT_CAPABILITY_REASONS,
			options?.blocked?.[module],
		);
	}
	return views;
}
