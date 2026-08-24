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
 * Backend adapters for the modem wire projection (Phase B).
 *
 * Each observation source normalizes its native view into the ONE
 * backend-agnostic {@link ProjectedModemSource} that `modem-wire-projection.ts`
 * consumes:
 *
 *   - {@link fromMmcliModem} — the legacy mmcli `Modem` (`modems-state.ts`).
 *     Its projection is BYTE-IDENTICAL to `modem-status.ts::buildModemsMessage`
 *     apart from the additive `stable_key`; a fixture diff proves it. This is
 *     the reference every other adapter matches.
 *   - {@link fromDbusView} — a `@ceralive/modem-control` observation, which
 *     additionally carries the Phase-B detail fields.
 *   - {@link fromRouterView} — a router-mode dongle from todo 18's netns
 *     metadata. It is `router-ethernet` class, honest about WHY modem control
 *     is unavailable, and carries NO radio status at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT MAKES THIS FILE WORTH READING
 * ────────────────────────────────────────────────────────────────────────────
 *
 * All three adapters derive `stable_key` by calling the SAME imported
 * `deriveModemStableKey` (`@ceraui/rpc`), and none of them derives its own.
 *
 * That is not a tidiness preference. A USB-composition switch moves a device
 * BETWEEN these adapter classes — a HiLink stick answering to
 * {@link fromRouterView} in router-ethernet mode becomes an MM-managed modem
 * answering to {@link fromMmcliModem} / {@link fromDbusView} in QMI mode — and
 * it re-enumerates on the way, so its MM index is re-issued and its ifname can
 * change. A per-adapter key would therefore change at EXACTLY the instant a
 * consumer is trying to follow the device through the transition, which is the
 * one moment `stable_key` exists for. The shared `ID_PATH`-anchored rule is
 * what makes the cross-adapter fixture in the test suite pass, and that fixture
 * is the proof of the whole design.
 *
 * The fourth adapter, {@link fromRouterCellularView}, has no `ID_PATH` of its
 * own to derive from — it describes a device the USB classifier found, not one
 * ModemManager enumerated — so it takes its key from the canonical record
 * `physical-identity.ts` resolved (which applied that SAME rule to the parent
 * USB device's udev `ID_PATH`). Before that record existed it keyed on the
 * interface NAME, which is the one property the twin HiLinks disprove.
 *
 * A corollary that is easy to get wrong: `stable_key` is NOT `shadow.ts`'s
 * `opaqueDeviceKey`. That one is an ifname digest whose only job is keying a
 * privacy-safe evidence record, and an ifname does not survive a mode switch.
 * They answer different questions; do not substitute one for the other.
 */

import type {
	ModemCellInfo,
	ModemDataUsage,
	ModemDeviceClass,
	ModemEsim,
	ModemRadioPower,
	ModemRecoveryState,
	ModemRegistrationRejection,
	RouterAdmin,
	UsbCompositionMode,
} from "@ceraui/rpc/schemas";
import { deriveModemStableKey } from "@ceraui/rpc/schemas";

import type {
	DongleMetadata,
	DongleState,
} from "../network/dongle-metadata.ts";
import { modemHardwareName } from "./modem-identity.ts";
import type {
	ProjectedModemAdditive,
	ProjectedModemConfig,
	ProjectedModemSource,
	WireModemStatus,
} from "./modem-wire-projection.ts";
import { getAvailableNetworksForModem, type Modem } from "./modems-state.ts";
import type { PhysicalDeviceRecord } from "./physical-identity.ts";
import { routerCellularDisplayName } from "./physical-identity.ts";
import type { SimPresence } from "./sim-presence.ts";

// The display-name rule lives with the identity record it titles, so the two
// cannot drift; re-exported here because this is where its callers already look.
export { routerCellularDisplayName } from "./physical-identity.ts";

// ── mmcli adapter ────────────────────────────────────────────────────────────

export interface MmcliAdapterOptions {
	/**
	 * The device's udev `ID_PATH`, resolved from `modem.generic.device` / sysfs
	 * by the caller. Absent ⇒ no `stable_key` is emitted, which is exactly the
	 * pre-Phase-B wire and the honest answer for a device we cannot anchor.
	 */
	readonly idPath?: string;
	/**
	 * The canonical physical record (`physical-identity.ts`), when the caller
	 * resolved one. Its `stableKey` was derived by the SAME rule from the SAME
	 * `ID_PATH`, so it can only ever supply a key this adapter could not resolve
	 * for itself — never contradict one.
	 */
	readonly identity?: PhysicalDeviceRecord;
}

/**
 * Normalize a legacy mmcli `Modem` into a projection source.
 *
 * Mirrors `modem-status.ts::buildModemMessage` field for field — `status`
 * verbatim, `network_type.supported` = `Object.keys(...)`, `available_networks`
 * through the SAME `getAvailableNetworksForModem` helper — so the projected
 * entry is byte-identical to the live broadcast. The MM runtime id keys the row.
 *
 * Of the Phase-B additive DETAIL block, mmcli observes only what it genuinely
 * reads — the registration rejection, the packet-service state, and the SIM's
 * own number. Every other additive field stays absent here, because
 * manufacturing one from a poorer source is how a UI ends up rendering a
 * confident value nobody measured.
 *
 * `modem.status` MUST be present — the live builder skips a modem without one,
 * so callers filter on that before adapting.
 */
export function fromMmcliModem(
	id: number,
	modem: Modem,
	options: MmcliAdapterOptions = {},
): ProjectedModemSource {
	if (modem.status === undefined) {
		throw new Error(`fromMmcliModem: modem ${id} has no status`);
	}

	const status: WireModemStatus = {
		connection: modem.status.connection,
		...(modem.status.network !== undefined
			? { network: modem.status.network }
			: {}),
		network_type: modem.status.network_type,
		signal: modem.status.signal,
		roaming: modem.status.roaming,
	};

	const stableKey =
		deriveModemStableKey(options.idPath) ?? options.identity?.stableKey;

	const source: Mutable<ProjectedModemSource> = {
		kind: "mm-managed",
		runtimeId: id,
		// An mm-managed row keys the wire by its MM id and never reaches the
		// synthetic allocator, so this fallback is only ever a grouping label.
		allocationKey: stableKey ?? `mm:${id}`,
		ifname: modem.ifname,
		name: modem.name,
		networkType: {
			supported: Object.keys(modem.network_type.supported),
			active: modem.network_type.active,
		},
		status,
		simVisibility: "visible",
		availableNetworks: getAvailableNetworksForModem(modem),
	};

	if (stableKey !== undefined) {
		source.stableKey = stableKey;
	}
	if (modem.model !== undefined) {
		source.model = modem.model;
	}
	if (modem.manufacturer !== undefined) {
		source.manufacturer = modem.manufacturer;
	}
	if (modem.config) {
		source.config = {
			apn: modem.config.apn,
			username: modem.config.username,
			password: modem.config.password,
			roaming: modem.config.roaming,
			network: modem.config.network,
			autoconfig: modem.config.autoconfig,
		};
	}
	if (modem.sim_presence !== undefined) {
		source.simPresence = modem.sim_presence;
	}
	if (modem.sim_lock) {
		source.simLock = modem.sim_lock;
	}

	// The wire `status` block is byte-locked against the pre-Phase-B builder, so
	// these two must travel as additive top-level fields and never inside it.
	const additive: Mutable<ProjectedModemAdditive> = {};
	if (modem.status.registration_rejection !== undefined) {
		additive.registration_rejection = modem.status.registration_rejection;
	}
	if (modem.status.packet_service_state !== undefined) {
		additive.packet_service_state = modem.status.packet_service_state;
	}
	if (modem.status.radio_power !== undefined) {
		additive.radio_power = modem.status.radio_power;
	}
	if (modem.own_numbers !== undefined && modem.own_numbers.length > 0) {
		additive.own_numbers = [...modem.own_numbers];
	}
	if (modem.iccid !== undefined && modem.iccid.length > 0) {
		additive.iccid = modem.iccid;
	}
	if (Object.keys(additive).length > 0) {
		source.additive = additive;
	}

	return source;
}

// ── D-Bus adapter ────────────────────────────────────────────────────────────

/** MM access-technology families → the legacy generation display string. */
const RAT_TO_GENERATION: Record<string, string> = {
	gsm: "2G",
	umts: "3G",
	lte: "4G",
	"5gnr": "5G",
};

const GENERATION_ORDER: Record<string, number> = {
	"2G": 1,
	"3G": 2,
	"3G+": 3,
	"4G": 4,
	"5G": 5,
};

/**
 * Map the SET of active RATs to the single legacy `network_type` display
 * string, highest generation wins — `lte + 5gnr` ⇒ `"5G"`, matching what
 * `mmcli.ts::mmConvertAccessTech` already does for the mmcli path. An empty set
 * yields `""`, mmcli's own empty-tech value.
 *
 * This is the same "fold two vocabularies before comparing them" discipline the
 * shadow classifier applies: the observer reports a RAT SET where mmcli reports
 * a GENERATION, and a 5G-NSA device is `{lte, 5gnr}` on one side and `"5G"` on
 * the other. Folding here is what keeps the two backends byte-identical on the
 * wire instead of merely similar.
 */
export function ratsToNetworkTypeDisplay(activeRats: Iterable<string>): string {
	let best = "";
	for (const rat of activeRats) {
		const generation = RAT_TO_GENERATION[rat];
		if (generation === undefined) {
			continue;
		}
		if (
			best === "" ||
			(GENERATION_ORDER[generation] ?? 0) > (GENERATION_ORDER[best] ?? 0)
		) {
			best = generation;
		}
	}
	return best;
}

/** The MM 3GPP registration dimension of an observation snapshot. */
export interface DbusRegistrationView {
	readonly status: string;
	readonly activeRats: ReadonlySet<string>;
}

/**
 * A `@ceralive/modem-control` observation, normalized for this seam.
 *
 * The Phase-B detail fields carry WIRE names and WIRE types deliberately: any
 * vocabulary folding between the package's enums and the schema's belongs in
 * the composition root that builds this view (todo 25), not in an adapter, for
 * the same reason `foldGeneration` lives beside the shadow classifier rather
 * than inside it. An adapter that also translated vocabularies would be the
 * second place a mapping could drift.
 *
 * Every detail field is optional and OMITTED when the observation did not carry
 * it — an absent field means "not observed", never "zero".
 */
export interface DbusModemView {
	/** MM runtime id, parsed from the runtime object path (`…/Modem/<n>`). */
	readonly runtimeId: number;
	/**
	 * The device's udev `ID_PATH`, from modem-control's `ID_PATH`-anchored
	 * physdev identity. Fed to the SAME `deriveModemStableKey` as every other
	 * adapter — see this file's header.
	 */
	readonly idPath?: string;
	readonly ifname: string;
	readonly model?: string;
	readonly manufacturer?: string;
	/** MM `Modem.EquipmentIdentifier`; its last 5 digits form the legacy name suffix. */
	readonly equipmentId?: string;
	/** MM state token — identical grammar to mmcli's `modem.generic.state`. */
	readonly mmState: string;
	readonly registration: DbusRegistrationView;
	/** MM `Modem.SignalQuality` (0-100). */
	readonly signal: number;
	readonly operatorName?: string;
	/**
	 * `Modem3gpp.NetworkRejection` — the network's OWN stated reason for refusing
	 * this radio. Absent means the modem reported none, never "registration is
	 * fine": a searching modem with no rejection has simply not been told why.
	 *
	 * It rides the ADDITIVE block, not `status`, because the wire `status` block
	 * is byte-locked against the pre-Phase-B builder — the same placement the
	 * mmcli adapter uses for the same two fields.
	 */
	readonly registrationRejection?: ModemRegistrationRejection;
	/** `Modem3gpp.PacketServiceState` — `attached` / `detached`. */
	readonly packetServiceState?: string;
	/** `Modem.PowerState`. A READING; this package publishes no setter for it. */
	readonly radioPower?: ModemRadioPower;
	/** Drives the legacy `scanning` connection override. */
	readonly scanning?: boolean;
	readonly supportedNetworkTypes: readonly string[];
	readonly activeNetworkType: string | null;
	readonly simLockRequired?: string;
	readonly simLockRemainingAttempts?: number;
	/** The NM-owned profile. Its absence is not a SIM claim — see `simPresence`. */
	readonly config?: ProjectedModemConfig;
	/**
	 * What MM saw in the slot, read from `Modem.Sim` / `Modem.SimSlots` /
	 * `Modem.StateFailedReason`. Absent ⇒ the fold could not answer.
	 */
	readonly simPresence?: SimPresence;
	/** The SIM's own number(s) from `Modem.OwnNumbers`. SENSITIVE — never logged. */
	readonly ownNumbers?: readonly string[];
	/** The SIM's ICCID from `Sim.SimIdentifier`. Displayed plainly, unlike above. */
	readonly iccid?: string;
	readonly availableNetworks?: ProjectedModemSource["availableNetworks"];

	// ── Phase-B detail (additive; each omitted when not observed) ─────────────
	readonly deviceClass?: ModemDeviceClass;
	readonly availabilityReason?: string;
	readonly slotLabel?: string;
	readonly recoveryState?: ModemRecoveryState;
	readonly usbMode?: UsbCompositionMode;
	readonly recommendedUsbMode?: UsbCompositionMode;
	readonly dataUsage?: ModemDataUsage;
	readonly firmwareRevision?: string;
	readonly esim?: ModemEsim;
	readonly cellInfo?: ModemCellInfo;
}

/**
 * Map a D-Bus observation to the SAME normalized source the mmcli adapter
 * produces, plus the Phase-B detail mmcli cannot see.
 *
 * The legacy half is a pure vocabulary translation — `connection` from the MM
 * state token (with `scanning` overriding it), `roaming` from the registration
 * status, `network_type` from the folded active-RAT set, `no_sim` from the
 * observed SIM slot — so a consumer cannot tell this row apart from an mmcli
 * one.
 */
export function fromDbusView(view: DbusModemView): ProjectedModemSource {
	const status: WireModemStatus = {
		connection: view.scanning ? "scanning" : view.mmState,
		...(view.operatorName !== undefined ? { network: view.operatorName } : {}),
		// The legacy `status.network_type` is the GENERATION display ("5G"), not
		// the mode label (`activeNetworkType`, e.g. "5g4g") — two different
		// fields that a glance at the wire makes look interchangeable.
		network_type: ratsToNetworkTypeDisplay(view.registration.activeRats),
		signal: view.signal,
		roaming: view.registration.status === "roaming",
	};

	const stableKey = deriveModemStableKey(view.idPath);

	const source: Mutable<ProjectedModemSource> = {
		kind: "mm-managed",
		runtimeId: view.runtimeId,
		allocationKey: stableKey ?? `mm:${view.runtimeId}`,
		ifname: view.ifname,
		name: buildDbusName(view),
		networkType: {
			supported: [...view.supportedNetworkTypes],
			active: view.activeNetworkType,
		},
		status,
		simVisibility: "visible",
	};

	if (stableKey !== undefined) {
		source.stableKey = stableKey;
	}
	if (view.model !== undefined) {
		source.model = view.model;
	}
	if (view.manufacturer !== undefined) {
		source.manufacturer = view.manufacturer;
	}
	if (view.config) {
		source.config = view.config;
	}
	if (view.simPresence !== undefined) {
		source.simPresence = view.simPresence;
	}
	if (view.availableNetworks !== undefined) {
		source.availableNetworks = view.availableNetworks;
	}
	// `"none"` INCLUDED: the mmcli path publishes `{required:"none"}` for an
	// unlocked SIM, so a `!== "none"` filter here (which the reference shape had)
	// makes a D-Bus row distinguishable from an mmcli one for the commonest
	// modem state. Absence means "not observed", not "unlocked".
	if (view.simLockRequired !== undefined) {
		source.simLock =
			view.simLockRemainingAttempts !== undefined
				? {
						required: view.simLockRequired,
						remainingAttempts: view.simLockRemainingAttempts,
					}
				: { required: view.simLockRequired };
	}

	const additive = buildDbusAdditive(view);
	if (additive !== undefined) {
		source.additive = additive;
	}

	return source;
}

/** Collect the observed Phase-B detail, or `undefined` when none was observed. */
function buildDbusAdditive(
	view: DbusModemView,
): ProjectedModemAdditive | undefined {
	const additive: Mutable<ProjectedModemAdditive> = {};
	let observed = false;

	if (view.deviceClass !== undefined) {
		additive.device_class = view.deviceClass;
		observed = true;
	}
	if (view.availabilityReason !== undefined) {
		additive.availability_reason = view.availabilityReason;
		observed = true;
	}
	if (view.slotLabel !== undefined) {
		additive.slot_label = view.slotLabel;
		observed = true;
	}
	if (view.recoveryState !== undefined) {
		additive.recovery_state = view.recoveryState;
		observed = true;
	}
	if (view.usbMode !== undefined) {
		additive.usb_mode = view.usbMode;
		observed = true;
	}
	if (view.recommendedUsbMode !== undefined) {
		additive.recommended_usb_mode = view.recommendedUsbMode;
		observed = true;
	}
	if (view.dataUsage !== undefined) {
		additive.data_usage = view.dataUsage;
		observed = true;
	}
	if (view.firmwareRevision !== undefined) {
		additive.firmware_revision = view.firmwareRevision;
		observed = true;
	}
	if (view.ownNumbers !== undefined && view.ownNumbers.length > 0) {
		additive.own_numbers = [...view.ownNumbers];
		observed = true;
	}
	if (view.iccid !== undefined && view.iccid.length > 0) {
		additive.iccid = view.iccid;
		observed = true;
	}
	if (view.esim !== undefined) {
		additive.esim = view.esim;
		observed = true;
	}
	if (view.cellInfo !== undefined) {
		additive.cell_info = view.cellInfo;
		observed = true;
	}
	if (view.registrationRejection !== undefined) {
		additive.registration_rejection = view.registrationRejection;
		observed = true;
	}
	if (view.packetServiceState !== undefined) {
		additive.packet_service_state = view.packetServiceState;
		observed = true;
	}
	if (view.radioPower !== undefined) {
		additive.radio_power = view.radioPower;
		observed = true;
	}

	return observed ? additive : undefined;
}

/**
 * Compose the hardware name exactly as `modem-registration.ts` does, so a D-Bus
 * name and an mmcli name for the same device match byte for byte.
 *
 * That is why it CALLS `modemHardwareName` rather than re-spelling its format
 * string. The retired body here was a hand-rolled `"<model> - <last5-of-imei>"`,
 * so the garbage-identity fallback that `modem-identity.ts` applies on the mmcli
 * path was silently absent on the D-Bus one — and `"dbus"` is the DEFAULT
 * backend, so the fallback reached no shipped device at all. Board-measured on
 * `ceralive2` (2026-08-18): the Qualcomm reference-design stick reporting
 * `manufacturer: 1` / `model: 0` was still titled **"0 - 54863"** with the fix
 * present in the binary, because this composer is the one the wire went through.
 */
function buildDbusName(view: DbusModemView): string {
	return modemHardwareName({
		model: view.model,
		manufacturer: view.manufacturer,
		firmwareRevision: view.firmwareRevision,
		equipmentId: view.equipmentId,
	});
}

// ── router-dongle adapter ────────────────────────────────────────────────────

/**
 * Why modem control is unavailable for a router-mode dongle, per lifecycle
 * state. Machine-stable tokens, keyed to operator copy on the frontend — never
 * rendered raw, the same contract the config-change reason tokens follow.
 *
 * `up` still carries a reason, and that is the point rather than an oversight:
 * a router dongle running its own embedded connection manager is CARRYING
 * TRAFFIC and is simultaneously un-configurable from here — no APN, no network
 * selection, no signal. An empty reason on a working dongle would leave the UI
 * to explain a disabled control with nothing to say.
 */
export const ROUTER_AVAILABILITY_REASONS: Record<DongleState, string> = {
	up: "router_managed",
	acquiring: "dongle_acquiring",
	down: "dongle_down",
};

/** A router-mode dongle as this seam sees it. */
export interface RouterDongleView {
	/** Host-visible interface — the veth peer (`dg<N>h`), not the netns side. */
	readonly ifname: string;
	/** `dongle<N>`; also the row's operator-facing name. */
	readonly slotLabel: string;
	readonly state: DongleState;
	/** The dongle's udev `ID_PATH`, from the metadata `usb_path`. */
	readonly idPath?: string;
	readonly model?: string;
	readonly manufacturer?: string;
}

/**
 * Build a {@link RouterDongleView} from todo 18's contract-v1 metadata record.
 *
 * The host-visible `veth_host` is used as the row's ifname — that is the
 * interface the netif surface, the policy-route check and the link-telemetry
 * label all already speak about, so the modems row and the network row name the
 * same thing. `usb_path` is the `ID_PATH` that anchors the shared `stable_key`,
 * which is what lets this row and the MM-managed row the SAME stick produces
 * after a mode switch resolve to one identity.
 */
export function routerViewFromDongleMetadata(
	metadata: DongleMetadata,
): RouterDongleView {
	const view: Mutable<RouterDongleView> = {
		ifname: metadata.veth_host,
		slotLabel: `dongle${metadata.slot}`,
		state: metadata.state,
	};
	if (metadata.usb_path.trim() !== "") {
		view.idPath = metadata.usb_path;
	}
	return view;
}

/**
 * Normalize a router-mode dongle into a projection source.
 *
 * It has NO ModemManager runtime id, so the projector allocates it a synthetic
 * id from the reserved ≥1000 namespace, keyed by the shared `stable_key` so the
 * id survives a replug.
 *
 * What this adapter deliberately does NOT produce:
 *
 *   - **No `status` block, and therefore no signal.** A router dongle exposes
 *     no radio telemetry to the host at all — no RSSI, no operator, no
 *     registration state. `modemSchema.status` is optional precisely so this
 *     row can say nothing instead of reporting a zeroed status block that a UI
 *     would render as "no signal" on a dongle streaming happily. There is no
 *     placeholder value here to "fill in later"; the absence IS the fact.
 *   - **Neither `config` nor `no_sim`.** The dongle has a SIM and manages it
 *     itself, so a `config` block would invent an APN we do not know and
 *     `no_sim: true` would deny a SIM that exists. `simVisibility: "opaque"`
 *     emits neither.
 *   - **No `available_networks`.** `{}` would claim a scan found nothing;
 *     nothing scanned.
 */
export function fromRouterView(view: RouterDongleView): ProjectedModemSource {
	const stableKey = deriveModemStableKey(view.idPath);

	const additive: ProjectedModemAdditive = {
		device_class: "router-ethernet",
		availability_reason: ROUTER_AVAILABILITY_REASONS[view.state],
		slot_label: view.slotLabel,
	};

	const source: Mutable<ProjectedModemSource> = {
		kind: "router",
		runtimeId: null,
		// The slot label is the STATED fallback for a dongle whose metadata
		// carries no usable `usb_path`: it is derived from the slot the netns
		// manager assigned, so it is stable for as long as the dongle keeps that
		// slot — deterministic, unlike array position, and honest about being a
		// weaker anchor than the ID_PATH it stands in for.
		allocationKey: stableKey ?? `dongle-slot:${view.slotLabel}`,
		ifname: view.ifname,
		name: view.slotLabel,
		networkType: { supported: [], active: null },
		simVisibility: "opaque",
		additive,
	};

	if (stableKey !== undefined) {
		source.stableKey = stableKey;
	}
	if (view.model !== undefined) {
		source.model = view.model;
	}
	if (view.manufacturer !== undefined) {
		source.manufacturer = view.manufacturer;
	}

	return source;
}

// ── classifier router-dongle adapter (no netns layer) ────────────────────────

/**
 * A router-mode dongle the USB classifier found, seen through its OWN host
 * interface rather than through a netns veth.
 *
 * This is the SAME physical class of device {@link fromRouterView} describes and
 * a DIFFERENT deployment of it, which is why it needs its own availability
 * token. A netns-claimed dongle hides behind a `dg<N>h` veth that owns the bond
 * toggle, so its modem row must refuse one. A classified dongle has no netns
 * layer — which is every shipped image today — so its `enx…` interface IS the
 * bonded link, and it is the only row that device gets once the Ethernet
 * section stops listing it. Handing it `router_managed` would tell an operator
 * that a dongle currently carrying bonded traffic cannot bond.
 */
export interface RouterCellularView {
	readonly ifname: string;
	readonly vendor: string;
	readonly model: string;
	/** Lowercase `xxxx:xxxx`, straight from the classifier marker. */
	readonly vidPid: string;
	/** Whether the host currently holds a routable address on this interface. */
	readonly hasAddress: boolean;
	/**
	 * The classifier's unit discriminator, present only when a same-SKU twin is
	 * attached. It is what separates two otherwise identical rows.
	 */
	readonly serial?: string;
	readonly admin?: RouterAdmin;
	/**
	 * The canonical physical record. Its presence is what gives this row a REAL
	 * `stable_key` — before it, a classified dongle was keyed on its interface
	 * name, the one property the twin HiLinks have proven unusable.
	 */
	readonly identity?: PhysicalDeviceRecord;
}

/**
 * Availability for a classified dongle, which is about REACHABILITY rather than
 * about who owns the toggle: with an address it is a live, bondable link
 * (`router_direct`), without one it is still bringing its DHCP lease up
 * (`dongle_acquiring`, reusing the existing sentence for the identical state).
 */
export function routerCellularAvailability(hasAddress: boolean): string {
	return hasAddress ? "router_direct" : "dongle_acquiring";
}

export function fromRouterCellularView(
	view: RouterCellularView,
): ProjectedModemSource {
	const additive: Mutable<ProjectedModemAdditive> = {
		device_class: "router-ethernet",
		availability_reason: routerCellularAvailability(view.hasAddress),
	};
	if (view.admin !== undefined) {
		additive.router_admin = view.admin;
	}
	const displayName =
		view.identity?.displayName ??
		routerCellularDisplayName(view.vendor, view.model, view.admin, view.serial);
	const stableKey = view.identity?.stableKey;

	const source: Mutable<ProjectedModemSource> = {
		kind: "router",
		runtimeId: null,
		// The ID_PATH-derived key when the identity resolver read one, and the
		// interface name only when it could not. That fallback's weakness is the
		// reason the resolver exists — the twin HiLinks rename against each other
		// on replug — but it is deterministic per poll, which array position is not.
		allocationKey: stableKey ?? `router-cellular:${view.ifname}`,
		ifname: view.ifname,
		name: displayName,
		model: displayName,
		manufacturer: view.vendor,
		networkType: { supported: [], active: null },
		simVisibility: "opaque",
		additive,
	};

	if (stableKey !== undefined) {
		source.stableKey = stableKey;
	}

	return source;
}

/** Strip `readonly` so an adapter can build its result incrementally. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
