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
 * Legacy numeric wire projection for the modems surface (Phase B).
 *
 * ONE seam projects a backend-agnostic {@link ProjectedModemSource} set into the
 * numeric-keyed `status.modems` shape the frontend already consumes — the shape
 * `modem-status.ts::buildModemsMessage` builds today. Three adapters feed it
 * (`modem-wire-adapters.ts`): mmcli, D-Bus, and the router-dongle view, so a
 * consumer cannot tell which backend observed a device.
 *
 * This module changes NOTHING on the live broadcast path: `broadcastModems`
 * still calls `buildModemsMessage` verbatim. The projector REPRODUCES that shape
 * and a fixture diff locks every legacy field byte-for-byte.
 *
 * Four invariants live HERE, at the seam, rather than scattered across adapters:
 *
 *   1. **Key ORDER is load-bearing.** The byte-compat claim is a
 *      `JSON.stringify` equality against the live builder's output, so
 *      {@link buildWireEntry} reproduces `buildModemMessage`'s insertion order
 *      exactly: `status` first, then the full block, then the additive block.
 *   2. **`autoconfig` is gated once**, in {@link resolveWireConfig}:
 *      `hasGsmAutoconfig && config.autoconfig` (mirrors `modem-status.ts:114`).
 *      Nothing else about the config block is transformed — see the note there.
 *   3. **A device with no MM id takes a synthetic id from the reserved ≥1000
 *      namespace** ({@link SYNTHETIC_ID_BASE}), collision-checked against the
 *      LIVE MM ids and stable across replug ({@link allocateSyntheticIds}).
 *   4. **The additive block is APPENDED, never interleaved**, and a source that
 *      carries no additive detail emits none of it — which is what keeps the
 *      mmcli path byte-identical to the pre-Phase-B wire.
 */

import type {
	CapabilityModuleClaims,
	ModemCellInfo,
	ModemDataUsage,
	ModemDataUsagePolicy,
	ModemDeviceClass,
	ModemEsim,
	ModemFiveGPreference,
	ModemRecoveryState,
	ModemRegistrationRejection,
	RouterAdmin,
	UsbCompositionMode,
} from "@ceraui/rpc/schemas";

// NOT the schema's same-named type. This union is wider (it also spells mmcli's
// `current`/`forbidden`/`unknown`); `modem-network-scan.ts` normalizes those away
// before anything is stored, so the WIRE is schema-valid either way. The reason
// to use this one is that `getAvailableNetworksForModem` and the live builder are
// typed with it — swapping in the schema type just relocates the cast.
import type { AvailableNetwork } from "./modems-state.ts";

/** Wire status block — identical shape to `modem-status.ts`'s internal type. */
export interface WireModemStatus {
	readonly connection: string;
	readonly network?: string;
	readonly network_type: string;
	readonly signal: number;
	readonly roaming: boolean;
}

/** Wire SIM-lock block — mirrors `modems-state.ts::SimLock`. */
export interface WireSimLock {
	readonly required: string;
	readonly remainingAttempts?: number;
}

/** The NM-owned connection profile as the projection seam sees it. */
export interface ProjectedModemConfig {
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	readonly roaming: boolean;
	readonly network: string;
	readonly autoconfig: boolean;
}

/**
 * Which control class a device belongs to. This decides ID ALLOCATION only —
 * the operator-facing class rides the additive `device_class` field, which is a
 * finer vocabulary (`usb` / `pcie-mhi` / `router-ethernet` / …).
 */
export type ProjectedDeviceKind = "mm-managed" | "router" | "unmanaged";

/**
 * Whether CeraUI can SEE this device's SIM at all.
 *
 * The legacy wire is binary — a `config` block, or `no_sim: true` — because
 * every device on it was ModemManager-managed, so the absence of a connection
 * profile really did prove the absence of a SIM. A router-mode dongle breaks
 * that: it has a SIM, runs its own embedded connection manager, and exposes
 * NEITHER fact to the host. Both legacy answers would therefore be false, so
 * `"opaque"` emits neither key and the UI renders the row without SIM detail.
 */
export type ProjectedSimVisibility = "visible" | "opaque";

/**
 * The eleven additive-optional Phase-B fields, in `modemSchema` declaration
 * order. Every one is OMITTED when its source did not observe it — a projection
 * never fabricates a field to make a row look complete.
 *
 * `stable_key` is deliberately NOT here: it is not observed detail, it is the
 * device's identity, so it lives on {@link ProjectedModemSource} itself and is
 * produced by the ONE shared `deriveModemStableKey` rule.
 */
export interface ProjectedModemAdditive {
	readonly device_class?: ModemDeviceClass;
	readonly availability_reason?: string;
	readonly slot_label?: string;
	readonly recovery_state?: ModemRecoveryState;
	readonly usb_mode?: UsbCompositionMode;
	readonly recommended_usb_mode?: UsbCompositionMode;
	readonly data_usage?: ModemDataUsage;
	readonly firmware_revision?: string;
	readonly esim?: ModemEsim;
	readonly cell_info?: ModemCellInfo;
	readonly registration_rejection?: ModemRegistrationRejection;
	readonly packet_service_state?: string;
	readonly router_admin?: RouterAdmin;
}

/**
 * A backend-agnostic, normalized view of ONE device. All three adapters produce
 * this; the projector consumes only this.
 */
export interface ProjectedModemSource {
	readonly kind: ProjectedDeviceKind;
	/**
	 * The ModemManager runtime id for an `mm-managed` device — the wire key.
	 * `null` for a device MM does not manage, which takes a synthetic id.
	 */
	readonly runtimeId: number | null;
	/**
	 * The wire `stable_key` — the ONLY identifier a consumer may use to
	 * correlate this device across a USB-mode transition. Produced by
	 * `deriveModemStableKey` (`@ceraui/rpc`) in EVERY adapter, never per-adapter.
	 * `undefined` when the device reports no `ID_PATH`; the field is then OMITTED
	 * from the wire rather than faked.
	 */
	readonly stableKey?: string;
	/**
	 * The key {@link allocateSyntheticIds} groups by. It is the `stableKey` when
	 * one could be derived, and a STATED per-adapter fallback otherwise.
	 *
	 * It is a separate field precisely because `stableKey` is allowed to be
	 * absent: a device with no `ID_PATH` still needs a deterministic, replug-
	 * stable allocation key, and silently substituting array order there is how a
	 * row's id starts moving on every poll.
	 */
	readonly allocationKey: string;
	readonly ifname: string;
	readonly name: string;
	readonly model?: string;
	readonly manufacturer?: string;
	readonly networkType: {
		readonly supported: readonly string[];
		readonly active: string | null;
	};
	/**
	 * Absent when the device reports no radio status. A router-mode dongle is
	 * the case that matters: it publishes no signal, no operator and no
	 * registration state, and `modemSchema.status` is optional precisely so a
	 * row like that can be honest instead of carrying a zeroed status block.
	 */
	readonly status?: WireModemStatus;
	readonly simVisibility: ProjectedSimVisibility;
	/** The NM profile. With `simVisibility: "visible"`, absence ⇒ `no_sim: true`. */
	readonly config?: ProjectedModemConfig;
	readonly simLock?: WireSimLock;
	readonly availableNetworks?: Record<string, AvailableNetwork>;
	readonly additive?: ProjectedModemAdditive;
}

/** The projected wire config block (post `autoconfig` gating). */
export interface WireModemConfig {
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	readonly roaming: boolean;
	readonly network: string;
	readonly autoconfig: boolean;
	readonly autoconfig_supported: boolean;
}

/** One projected wire entry — same field set + key ORDER as `buildModemMessage`. */
export type WireModemEntry = {
	status?: WireModemStatus;
	ifname?: string;
	name?: string;
	model?: string;
	manufacturer?: string;
	network_type?: { supported: string[]; active: string | null };
	config?: WireModemConfig;
	no_sim?: true;
	sim_lock?: WireSimLock;
	available_networks?: Record<string, AvailableNetwork>;
	device_class?: ModemDeviceClass;
	availability_reason?: string;
	slot_label?: string;
	recovery_state?: ModemRecoveryState;
	usb_mode?: UsbCompositionMode;
	recommended_usb_mode?: UsbCompositionMode;
	data_usage?: ModemDataUsage;
	data_usage_policy?: ModemDataUsagePolicy;
	firmware_revision?: string;
	esim?: ModemEsim;
	cell_info?: ModemCellInfo;
	registration_rejection?: ModemRegistrationRejection;
	packet_service_state?: string;
	router_admin?: RouterAdmin;
	stable_key?: string;
	capability_modules?: CapabilityModuleClaims;
	five_g_preference?: ModemFiveGPreference;
};

/** The projected wire message — `Record<numericId(string), entry>`. */
export type WireModemsMessage = Record<string, WireModemEntry>;

/**
 * First reserved synthetic id. A device ModemManager does not manage allocates
 * at or above this.
 *
 * It is a FLOOR, not a guarantee of freedom: MM ids are monotonic and a
 * long-lived board can in principle issue one ≥1000, so every candidate is
 * still checked against the live set (see {@link allocateSyntheticIds}).
 */
export const SYNTHETIC_ID_BASE = 1000;

/**
 * Durable LOCAL state stamped onto a row — resolved from device config, never
 * observed by any adapter. Grouped so the two builders keep one argument for it
 * rather than growing a positional parameter per additive local field.
 */
interface ProjectedLocalState {
	readonly usagePolicy?: ModemDataUsagePolicy | undefined;
	readonly capabilityModules?: CapabilityModuleClaims | undefined;
	readonly fiveGPreference?: ModemFiveGPreference | undefined;
}

export interface ProjectModemWireDeps {
	/** `setup.has_gsm_autoconfig` — gates the wire `autoconfig` value. */
	readonly hasGsmAutoconfig: boolean;
	/**
	 * The operator's persisted data-usage policy for a row, injected because it is
	 * durable LOCAL state rather than anything a source observed — so no adapter
	 * can carry it and this module stays pure.
	 */
	readonly usagePolicyFor?: (
		legacyId: string,
		stableKey?: string,
	) => ModemDataUsagePolicy | undefined;
	/**
	 * The seven-module support-claim matrix for a row. Injected for the same
	 * reason as the usage policy: it is resolved from device config plus a
	 * capability probe, neither of which any source observed.
	 */
	readonly capabilityModulesFor?: (
		stableKey?: string,
	) => CapabilityModuleClaims | undefined;
	/**
	 * The `five-g-pref` module's read half for a row, or `undefined` when its
	 * claim is not surfaceable. Injected for the same reason as the two above: it
	 * is resolved from a config gate plus a capability probe, so no adapter
	 * observed it and this module stays pure.
	 */
	readonly fiveGPreferenceFor?: (
		stableKey?: string,
	) => ModemFiveGPreference | undefined;
	/**
	 * Prior `allocationKey → synthetic id` allocations, retained across
	 * snapshots so a replugged device gets its OLD id back. Optional; an empty
	 * map when omitted.
	 */
	readonly previousSyntheticIds?: ReadonlyMap<string, number>;
	/**
	 * Mirrors `buildModemsMessage(modemsFullState)`: `undefined` ⇒ every entry
	 * carries its full descriptor; otherwise only the listed MM ids do and the
	 * rest are status-only partials.
	 *
	 * A source with NO status is always full regardless — a status-only entry
	 * for a statusless device would serialize to `{}`.
	 */
	readonly fullState?: Record<number, true>;
}

export interface ProjectModemWireResult {
	readonly message: WireModemsMessage;
	/**
	 * The `allocationKey → synthetic id` map to retain for the NEXT projection
	 * so replug stability holds. Carries only non-MM allocations.
	 */
	readonly syntheticIds: ReadonlyMap<string, number>;
}

/**
 * Map a device's connection profile to the legacy wire config block.
 *
 * `autoconfig` is the ONE transformed field: `hasGsmAutoconfig && autoconfig`,
 * mirroring `modem-status.ts:114`. Everything else passes through VERBATIM.
 *
 * That verbatim pass-through is deliberate and is a correction against the
 * reference implementation this module's shape is drawn from, which also
 * cleared the APN whenever auto-config resolved on. The live mmcli builder does
 * no such thing — it copies `modem.config.apn` unconditionally — so clearing it
 * here would make the projection disagree with the wire it claims to reproduce
 * for any modem whose stored APN outlived an auto-config toggle. An APN policy
 * change is a change to `modem-registration.ts`, not something a projection may
 * smuggle in.
 */
export function resolveWireConfig(
	config: ProjectedModemConfig,
	hasGsmAutoconfig: boolean,
): WireModemConfig {
	return {
		apn: config.apn,
		username: config.username,
		password: config.password,
		roaming: config.roaming,
		network: config.network,
		autoconfig: hasGsmAutoconfig && config.autoconfig,
		autoconfig_supported: hasGsmAutoconfig,
	};
}

/**
 * Allocate a stable synthetic wire id (≥ {@link SYNTHETIC_ID_BASE}) for every
 * source with no MM runtime id, collision-checked against the live MM ids.
 *
 * Guarantees:
 *
 *   - **NEVER collides with a live MM id.** "≥1000 is always safe" is an
 *     assumption, not a fact — MM ids are monotonic and a board that has
 *     enumerated enough modems can reach the reserved range. Every candidate is
 *     tested against `usedMmIds` AND against ids claimed earlier in this pass,
 *     so a live id of exactly 1000 pushes the allocation to the next free slot
 *     rather than producing a duplicate wire key.
 *   - **REPLUG-STABLE.** Allocation walks sources in `allocationKey` order —
 *     never array or insertion order, neither of which survives a replug — and
 *     reinstates a source's prior id from `previous` whenever it is still free.
 *     So the same physical device keeps the same id across unplug → replug, and
 *     across a D-Bus → mmcli backend fallback, because the key is the shared
 *     `ID_PATH`-anchored one rather than anything the backend chose.
 */
export function allocateSyntheticIds(
	sources: readonly ProjectedModemSource[],
	usedMmIds: ReadonlySet<number>,
	previous: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
	const synthetic = sources
		.filter((source) => resolveMmId(source) === undefined)
		.slice()
		.sort((a, b) => a.allocationKey.localeCompare(b.allocationKey));

	const result = new Map<string, number>();
	const claimed = new Set<number>();

	// Pass 1 — reinstate a prior id while it is still collision-free. This is
	// what makes an id survive a replug, so it runs BEFORE any fresh allocation
	// could take the slot the returning device used to hold.
	for (const source of synthetic) {
		if (result.has(source.allocationKey)) {
			continue;
		}
		const prior = previous.get(source.allocationKey);
		if (
			prior !== undefined &&
			prior >= SYNTHETIC_ID_BASE &&
			!usedMmIds.has(prior) &&
			!claimed.has(prior)
		) {
			result.set(source.allocationKey, prior);
			claimed.add(prior);
		}
	}

	// Pass 2 — lowest free id ≥ base for anything still unallocated.
	for (const source of synthetic) {
		if (result.has(source.allocationKey)) {
			continue;
		}
		let id = SYNTHETIC_ID_BASE;
		while (usedMmIds.has(id) || claimed.has(id)) {
			id++;
		}
		result.set(source.allocationKey, id);
		claimed.add(id);
	}

	return result;
}

/** The MM runtime id of an mm-managed source, or `undefined` for a synthetic row. */
function resolveMmId(source: ProjectedModemSource): number | undefined {
	return source.kind === "mm-managed" && source.runtimeId !== null
		? source.runtimeId
		: undefined;
}

/**
 * Build ONE wire entry with the EXACT field set and key ORDER of
 * `modem-status.ts::buildModemMessage`, then append the additive block.
 *
 * Order is asserted by a `JSON.stringify` fixture diff, not left incidental.
 */
function buildWireEntry(
	source: ProjectedModemSource,
	hasGsmAutoconfig: boolean,
	sendFull: boolean,
	local: ProjectedLocalState,
): WireModemEntry {
	const entry: WireModemEntry = {};

	if (source.status !== undefined) {
		entry.status = source.status;
	}

	if (!sendFull) {
		return entry;
	}

	entry.ifname = source.ifname;
	entry.name = source.name;
	if (source.model !== undefined) {
		entry.model = source.model;
	}
	if (source.manufacturer !== undefined) {
		entry.manufacturer = source.manufacturer;
	}
	entry.network_type = {
		supported: [...source.networkType.supported],
		active: source.networkType.active,
	};

	// The legacy binary is preserved for every device whose SIM CeraUI can see;
	// an opaque device emits neither key rather than guessing which lie to tell.
	if (source.simVisibility === "visible") {
		if (source.config) {
			entry.config = resolveWireConfig(source.config, hasGsmAutoconfig);
		} else {
			entry.no_sim = true;
		}
	}

	if (source.simLock) {
		entry.sim_lock = source.simLock;
	}
	if (source.availableNetworks !== undefined) {
		entry.available_networks = source.availableNetworks;
	}

	appendAdditive(entry, source, local);

	return entry;
}

/**
 * Append the additive Phase-B block, in `modemSchema` declaration order.
 *
 * Every field is written only when its source OBSERVED it, so a source carrying
 * no additive detail (the mmcli path) leaves the entry byte-identical to the
 * pre-Phase-B wire apart from `stable_key`.
 */
function appendAdditive(
	entry: WireModemEntry,
	source: ProjectedModemSource,
	local: ProjectedLocalState,
): void {
	const additive = source.additive;
	if (additive !== undefined) {
		if (additive.device_class !== undefined) {
			entry.device_class = additive.device_class;
		}
		if (additive.availability_reason !== undefined) {
			entry.availability_reason = additive.availability_reason;
		}
		if (additive.slot_label !== undefined) {
			entry.slot_label = additive.slot_label;
		}
		if (additive.recovery_state !== undefined) {
			entry.recovery_state = additive.recovery_state;
		}
		if (additive.usb_mode !== undefined) {
			entry.usb_mode = additive.usb_mode;
		}
		if (additive.recommended_usb_mode !== undefined) {
			entry.recommended_usb_mode = additive.recommended_usb_mode;
		}
		if (additive.data_usage !== undefined) {
			entry.data_usage = additive.data_usage;
		}
		if (additive.firmware_revision !== undefined) {
			entry.firmware_revision = additive.firmware_revision;
		}
		if (additive.esim !== undefined) {
			entry.esim = additive.esim;
		}
		if (additive.cell_info !== undefined) {
			entry.cell_info = additive.cell_info;
		}
		if (additive.registration_rejection !== undefined) {
			entry.registration_rejection = additive.registration_rejection;
		}
		if (additive.packet_service_state !== undefined) {
			entry.packet_service_state = additive.packet_service_state;
		}
		if (additive.router_admin !== undefined) {
			entry.router_admin = additive.router_admin;
		}
	}

	if (local.usagePolicy !== undefined) {
		entry.data_usage_policy = local.usagePolicy;
	}

	if (source.stableKey !== undefined) {
		entry.stable_key = source.stableKey;
	}

	if (local.capabilityModules !== undefined) {
		entry.capability_modules = local.capabilityModules;
	}

	// The read half of an IMPLEMENTED module rides the row only where its claim is
	// SURFACEABLE, so a consumer never has to re-derive the ladder to know whether
	// to render a control — and a module whose claim is `implemented` (gate off) or
	// `unavailable` publishes nothing rather than an empty offer list, which would
	// be indistinguishable from a modem that advertised no postures.
	if (local.fiveGPreference !== undefined) {
		entry.five_g_preference = local.fiveGPreference;
	}
}

/**
 * Project a normalized source set into the legacy numeric wire message.
 *
 * mm-managed devices key by their MM runtime id; everything else keys by a
 * collision-checked, replug-stable synthetic id (≥ {@link SYNTHETIC_ID_BASE}).
 */
export function projectModemWire(
	sources: readonly ProjectedModemSource[],
	deps: ProjectModemWireDeps,
): ProjectModemWireResult {
	const usedMmIds = new Set<number>();
	for (const source of sources) {
		const mmId = resolveMmId(source);
		if (mmId !== undefined) {
			usedMmIds.add(mmId);
		}
	}

	const syntheticIds = allocateSyntheticIds(
		sources,
		usedMmIds,
		deps.previousSyntheticIds,
	);

	const message: WireModemsMessage = {};
	for (const source of sources) {
		const mmId = resolveMmId(source);
		const id = mmId ?? syntheticIds.get(source.allocationKey);
		if (id === undefined) {
			continue;
		}
		// A statusless device is always full: a status-only partial for it would
		// serialize to `{}`, which tells a consumer nothing at all.
		const sendFull =
			deps.fullState === undefined ||
			source.status === undefined ||
			mmId === undefined ||
			deps.fullState[mmId] === true;
		const local: ProjectedLocalState = sendFull
			? {
					usagePolicy: deps.usagePolicyFor?.(String(id), source.stableKey),
					capabilityModules: deps.capabilityModulesFor?.(source.stableKey),
					fiveGPreference: deps.fiveGPreferenceFor?.(source.stableKey),
				}
			: {};
		message[String(id)] = buildWireEntry(
			source,
			deps.hasGsmAutoconfig,
			sendFull,
			local,
		);
	}

	return { message, syntheticIds };
}
