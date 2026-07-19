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
 * Backend adapters for the legacy numeric wire projection (Phase B, T5.3).
 *
 * Each control backend normalizes its native modem view into the ONE
 * backend-agnostic {@link ProjectedModemSource} the projector
 * (`modem-wire-projection.ts`) consumes:
 *
 *   - {@link fromMmcliModem}   — the legacy mmcli `Modem` (`modems-state.ts`). Its
 *     output projects BYTE-IDENTICALLY to `modem-status.ts::buildModemsMessage`
 *     (the regression lock proves it). This is the reference the dbus side must
 *     match.
 *   - {@link fromDbusView}     — a `@ceralive/modem-control` observation view:
 *     the epoch-scoped `CellularSnapshot` (state dimensions + identity) plus the
 *     slow MM-interface descriptor (model/manufacturer/signal/operator/ports) and
 *     the NM-owned connection profile. mmcli-native tokens and dbus-native enums
 *     map to the SAME legacy wire, so the frontend cannot tell them apart.
 *
 * The dbus snapshot deliberately omits secrets (ICCID/EID/APN/PIN — see the
 * package's `domain/identity.ts` and the shadow mapper); the config block therefore
 * comes from the NM readback the descriptor carries, never from the MM snapshot.
 */

import type {
	ProjectedModemConfig,
	ProjectedModemSource,
	WireModemStatus,
} from "./modem-wire-projection.ts";
import { getAvailableNetworksForModem, type Modem } from "./modems-state.ts";

// ── mmcli adapter ────────────────────────────────────────────────────────────

/**
 * Normalize a legacy mmcli `Modem` (already in `modemsState`) into a projection
 * source. Mirrors `modem-status.ts::buildModemMessage` field-for-field so the
 * projected entry is byte-identical to the live broadcast — `status` verbatim,
 * `network_type.supported` = `Object.keys(...)`, `available_networks` via the same
 * `getAvailableNetworksForModem` helper. The MM runtime id keys the wire row.
 *
 * `modem.status` MUST be present (the live builder skips modems without status);
 * callers filter on that before adapting.
 */
export function fromMmcliModem(id: number, modem: Modem): ProjectedModemSource {
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

	const source: {
		-readonly [K in keyof ProjectedModemSource]: ProjectedModemSource[K];
	} = {
		kind: "mm-managed",
		runtimeId: id,
		stableKey: `mm:${id}`,
		ifname: modem.ifname,
		name: modem.name,
		networkType: {
			supported: Object.keys(modem.network_type.supported),
			active: modem.network_type.active,
		},
		status,
		availableNetworks: getAvailableNetworksForModem(modem),
	};
	if (modem.model !== undefined) source.model = modem.model;
	if (modem.manufacturer !== undefined)
		source.manufacturer = modem.manufacturer;
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
	if (modem.sim_lock) source.simLock = modem.sim_lock;

	return source;
}

// ── dbus adapter ─────────────────────────────────────────────────────────────

/** MM `MMModemAccessTechnology` families → the legacy generation display string. */
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
 * Map the SET of active RATs to the single legacy `network_type` display string
 * (highest generation wins, e.g. `lte + 5gnr` → "5G"), matching
 * `mmcli.ts::mmConvertAccessTech`. Empty set → "" (mmcli's empty-tech value).
 */
export function ratsToNetworkTypeDisplay(
	activeRats: ReadonlySet<string>,
): string {
	let best = "";
	for (const rat of activeRats) {
		const gen = RAT_TO_GENERATION[rat];
		if (gen === undefined) {
			continue;
		}
		if (
			best === "" ||
			(GENERATION_ORDER[gen] ?? 0) > (GENERATION_ORDER[best] ?? 0)
		) {
			best = gen;
		}
	}
	return best;
}

/** The dbus-native SIM-slot shape (a `CellularSnapshot.simSlots[]` element). */
export interface DbusSimSlotView {
	readonly occupied: boolean;
	readonly active: boolean;
	readonly lock: string;
}

/** The MM 3gpp registration dimension of a `CellularSnapshot`. */
export interface DbusRegistrationView {
	readonly status: string;
	readonly activeRats: ReadonlySet<string>;
}

/**
 * A `@ceralive/modem-control` observation view: the epoch-scoped state snapshot
 * plus the slow MM-interface descriptor and the NM-owned config. This is the
 * "richer snapshot" the dbus backend projects FROM. Every field here has a legacy
 * wire counterpart; the adapter maps dbus-native enums to the mmcli-native tokens.
 */
export interface DbusModemView {
	/** MM runtime id parsed from the runtime object path (`…/Modem/<n>`). */
	readonly runtimeId: number;
	readonly ifname: string;
	/** MM `Modem.Model` (descriptor). */
	readonly model?: string;
	/** MM `Modem.Manufacturer` (descriptor). */
	readonly manufacturer?: string;
	/** MM `Modem.EquipmentIdentifier` — last-5 form the legacy `name` suffix. */
	readonly equipmentId?: string;
	/** MM `MMModemState` token — identical grammar to mmcli `modem.generic.state`. */
	readonly mmState: string;
	/** MM 3gpp registration + active-RAT set. */
	readonly registration: DbusRegistrationView;
	/** MM `Modem.SignalQuality` value (0-100). */
	readonly signal: number;
	/** MM `Modem3gpp.OperatorName` (descriptor). */
	readonly operatorName?: string;
	/** Whether the modem is scanning (drives the `scanning` connection override). */
	readonly scanning?: boolean;
	/** Legacy supported-mode labels (from MM `Modem.SupportedModes`, mmcli-normalized). */
	readonly supportedNetworkTypes: readonly string[];
	/** Legacy active-mode label, or null. */
	readonly activeNetworkType: string | null;
	readonly simSlots: readonly DbusSimSlotView[];
	/** SIM lock the modem currently requires (MM `Modem.UnlockRequired`), or none. */
	readonly simLockRequired?: string;
	readonly simLockRemainingAttempts?: number;
	/** NM-owned connection profile; absent ⇒ no SIM/profile ⇒ wire `no_sim`. */
	readonly config?: ProjectedModemConfig;
	readonly availableNetworks?: ProjectedModemSource["availableNetworks"];
}

/**
 * Map a dbus observation view to the SAME normalized projection source the mmcli
 * adapter produces. The legacy `connection` token comes from `mmState` (same MM
 * grammar), `scanning` overriding it; `roaming` from the registration status;
 * `network_type` display from the active-RAT set; `no_sim` from the absence of an
 * NM profile. mm-managed ⇒ the MM runtime id keys the wire row.
 */
export function fromDbusView(view: DbusModemView): ProjectedModemSource {
	const connection = view.scanning ? "scanning" : view.mmState;
	const roaming = view.registration.status === "roaming";
	// `status.network_type` is the legacy GENERATION display ("5G"/"4G"), derived
	// from the active RAT set exactly as mmcli's `mmConvertAccessTech` does — NOT
	// the mode label (`activeNetworkType`, e.g. "5g4g"), which is a separate field.
	const networkTypeDisplay = ratsToNetworkTypeDisplay(
		view.registration.activeRats,
	);

	const status: WireModemStatus = {
		connection,
		...(view.operatorName !== undefined ? { network: view.operatorName } : {}),
		network_type: networkTypeDisplay,
		signal: view.signal,
		roaming,
	};

	const source: {
		-readonly [K in keyof ProjectedModemSource]: ProjectedModemSource[K];
	} = {
		kind: "mm-managed",
		runtimeId: view.runtimeId,
		stableKey: `mm:${view.runtimeId}`,
		ifname: view.ifname,
		name: buildDbusName(view),
		networkType: {
			supported: [...view.supportedNetworkTypes],
			active: view.activeNetworkType,
		},
		status,
	};
	if (view.model !== undefined) source.model = view.model;
	if (view.manufacturer !== undefined) source.manufacturer = view.manufacturer;
	if (view.config) source.config = view.config;
	if (view.availableNetworks) source.availableNetworks = view.availableNetworks;
	if (view.simLockRequired !== undefined && view.simLockRequired !== "none") {
		source.simLock =
			view.simLockRemainingAttempts !== undefined
				? {
						required: view.simLockRequired,
						remainingAttempts: view.simLockRemainingAttempts,
					}
				: { required: view.simLockRequired };
	}

	return source;
}

/**
 * Compose the legacy hardware name `"<model> - <last5-imei>"` exactly as
 * `modem-registration.ts` does (`${model} - ${partialImei}`), so the dbus and
 * mmcli names match byte-for-byte.
 */
function buildDbusName(view: DbusModemView): string {
	const model = view.model ?? "";
	const imei = view.equipmentId ?? "";
	const partial = imei.length > 5 ? imei.substring(imei.length - 5) : imei;
	return `${model} - ${partial}`;
}

// ── router / unmanaged adapter ───────────────────────────────────────────────

/**
 * A device ModemManager cannot control (HiLink/RNDIS/NCM router-mode, or an
 * unmanaged stick surfaced disabled-with-reason). It has NO MM runtime id, so the
 * projector assigns it a synthetic id from the reserved ≥1000 namespace, keyed by
 * a hardware-stable identity (`stableKey`) so the id survives replug.
 */
export interface RouterDeviceView {
	readonly kind: "router" | "unmanaged";
	/** Hardware-stable identity (USB port path / sysfs handle) — never array order. */
	readonly stableKey: string;
	readonly ifname: string;
	readonly name: string;
	readonly model?: string;
	readonly manufacturer?: string;
	readonly status: WireModemStatus;
	readonly networkType?: {
		readonly supported: readonly string[];
		readonly active: string | null;
	};
}

/**
 * Normalize a router/unmanaged device into a projection source. `runtimeId` is
 * `null` (no MM id); the projector allocates its ≥1000 synthetic id. The legacy
 * wire entry carries only the existing fields — no additive Phase-B fields (T5.4).
 */
export function fromRouterView(view: RouterDeviceView): ProjectedModemSource {
	const source: {
		-readonly [K in keyof ProjectedModemSource]: ProjectedModemSource[K];
	} = {
		kind: view.kind,
		runtimeId: null,
		stableKey: view.stableKey,
		ifname: view.ifname,
		name: view.name,
		networkType: view.networkType ?? { supported: [], active: null },
		status: view.status,
		availableNetworks: {},
	};
	if (view.model !== undefined) source.model = view.model;
	if (view.manufacturer !== undefined) source.manufacturer = view.manufacturer;
	return source;
}
