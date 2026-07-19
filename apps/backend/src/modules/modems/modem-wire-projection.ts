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
 * Legacy numeric wire projection (Phase B, T5.3).
 *
 * The single seam that projects a backend-agnostic {@link ProjectedModemSource}
 * set into the EXISTING numeric-id modem wire shape the frontend already consumes
 * (`status.modems` — `Record<numericModemId, entry>`, built today by
 * `modem-status.ts::buildModemsMessage`). Both control backends feed this ONE
 * projector:
 *
 *   - mmcli   → `modem-wire-adapters.ts::fromMmcliModem`
 *   - dbus    → `modem-wire-adapters.ts::fromDbusView` (over `@ceralive/modem-control`)
 *
 * so the frontend can never tell which backend is live (the "byte-compatible"
 * claim, proven by the golden-fixture test). This module changes NOTHING on the
 * live mmcli broadcast path — `broadcastModems` still calls `buildModemsMessage`
 * verbatim; the projector reproduces that exact shape and the regression test
 * locks it byte-for-byte.
 *
 * Three legacy-compat invariants live HERE, at the adapter seam, not scattered:
 *
 *   1. `autoconfig` is mapped once, in {@link resolveWireConfig}: the wire value is
 *      `has_gsm_autoconfig && config.autoconfig` (mirrors `modem-status.ts:114`).
 *   2. The literal `"auto"` is NEVER echoed. An auto-config APN resolves to its
 *      concrete legacy value — an empty string — exactly as the mmcli path already
 *      clears it (`modem-registration.ts::applyAutoconfigToModemConfig`).
 *   3. Router / unmanaged rows (devices ModemManager cannot manage) take synthetic
 *      numeric ids from the reserved ≥1000 namespace ({@link SYNTHETIC_ID_BASE}),
 *      collision-checked against the live MM runtime ids and stable across replug
 *      (keyed by a hardware-stable identity), via {@link allocateSyntheticIds}.
 */

import type { AvailableNetwork } from "./modems-state.ts";

/** Wire status block — identical shape to `modem-status.ts::ModemsResponseModemStatus`. */
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

/**
 * The NM-owned connection profile as seen by the projection seam. `apn` MAY be the
 * `"auto"` policy sentinel here (the Auto-APN arm maps `apn:"auto"` → NM
 * `gsm.auto-config yes`); {@link resolveWireConfig} is the single place that
 * reconciles it — the sentinel never reaches the wire.
 */
export interface ProjectedModemConfig {
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	readonly roaming: boolean;
	readonly network: string;
	readonly autoconfig: boolean;
}

/** Which control class a device belongs to. `router`/`unmanaged` are non-MM. */
export type ProjectedDeviceKind = "mm-managed" | "router" | "unmanaged";

/**
 * A backend-agnostic, normalized view of ONE device. The mmcli and dbus adapters
 * both produce this; the projector consumes only this. It carries exactly the
 * information the legacy wire needs — no additive Phase-B fields (those are T5.4).
 */
export interface ProjectedModemSource {
	readonly kind: ProjectedDeviceKind;
	/**
	 * The ModemManager runtime id for an `mm-managed` device — the wire key. `null`
	 * for router/unmanaged devices, which have no MM id and get a synthetic id.
	 */
	readonly runtimeId: number | null;
	/**
	 * A hardware-stable identity (e.g. USB port path / logical slot) used to keep a
	 * router/unmanaged device's synthetic id STABLE across unplug→replug. Never the
	 * MM runtime path (which MM reassigns) and never a secret (ICCID/EID).
	 */
	readonly stableKey: string;
	readonly ifname: string;
	readonly name: string;
	readonly model?: string;
	readonly manufacturer?: string;
	readonly networkType: {
		readonly supported: readonly string[];
		readonly active: string | null;
	};
	readonly status: WireModemStatus;
	/** Present when a SIM/profile exists; absent ⇒ the wire carries `no_sim: true`. */
	readonly config?: ProjectedModemConfig;
	readonly simLock?: WireSimLock;
	readonly availableNetworks?: Record<string, AvailableNetwork>;
}

/** The projected wire config block (post autoconfig / "auto" resolution). */
export interface WireModemConfig {
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	readonly roaming: boolean;
	readonly network: string;
	readonly autoconfig: boolean;
}

/** One projected wire entry — same field set + key ORDER as `buildModemMessage`. */
export type WireModemEntry = {
	status: WireModemStatus;
	ifname?: string;
	name?: string;
	model?: string;
	manufacturer?: string;
	network_type?: { supported: string[]; active: string | null };
	config?: WireModemConfig;
	no_sim?: true;
	sim_lock?: WireSimLock;
	available_networks?: Record<string, AvailableNetwork>;
};

/** The projected wire message — `Record<numericId(string), entry>`. */
export type WireModemsMessage = Record<string, WireModemEntry>;

/** First reserved synthetic id. Router/unmanaged rows allocate at or above this. */
export const SYNTHETIC_ID_BASE = 1000;

/** The Auto-APN policy sentinel — a wire value NEVER echoes it. */
export const AUTO_APN_SENTINEL = "auto";

export interface ProjectModemWireDeps {
	/** `setup.has_gsm_autoconfig` — gates the wire `autoconfig` value. */
	readonly hasGsmAutoconfig: boolean;
	/**
	 * Prior `stableKey → synthetic id` allocations, retained across snapshots so a
	 * replugged device gets its OLD id back. Optional; a fresh `Map` when omitted.
	 */
	readonly previousSyntheticIds?: ReadonlyMap<string, number>;
}

export interface ProjectModemWireResult {
	readonly message: WireModemsMessage;
	/**
	 * The `stableKey → synthetic id` map to retain for the NEXT projection so
	 * replug stability holds. Carries only router/unmanaged allocations.
	 */
	readonly syntheticIds: ReadonlyMap<string, number>;
}

/**
 * Map a device's NM-owned config to the legacy wire config. This is THE seam for
 * `autoconfig` + the `"auto"` sentinel:
 *
 *   - `autoconfig` = `hasGsmAutoconfig && config.autoconfig` (mirrors the mmcli
 *     gate at `modem-status.ts:114`).
 *   - when auto-config resolves ON, or the raw APN is the `"auto"` sentinel, the
 *     wire APN is the concrete legacy value — empty — exactly as the mmcli path
 *     clears it. The literal `"auto"` is never echoed to any client.
 *
 * `username`/`password`/`roaming`/`network` pass through verbatim (the mmcli path
 * echoes them unchanged), so an mmcli-derived config projects byte-identically.
 */
export function resolveWireConfig(
	config: ProjectedModemConfig,
	hasGsmAutoconfig: boolean,
): WireModemConfig {
	const autoconfig = hasGsmAutoconfig && config.autoconfig;
	const apn = autoconfig || config.apn === AUTO_APN_SENTINEL ? "" : config.apn;
	return {
		apn,
		username: config.username,
		password: config.password,
		roaming: config.roaming,
		network: config.network,
		autoconfig,
	};
}

/**
 * Allocate a stable synthetic wire id (≥ {@link SYNTHETIC_ID_BASE}) for every
 * router/unmanaged source, collision-checked against the live MM runtime ids.
 *
 * Guarantees:
 *   - NEVER collides with a live MM id (MM ids are monotonic and could in principle
 *     exceed 1000, so a raw "≥1000 is always safe" assumption is wrong — every
 *     candidate is checked against `usedMmIds` AND ids claimed earlier this pass).
 *   - REPLUG-STABLE: allocation walks sources in `stableKey` order (never array /
 *     insertion order, which does not survive replug) and reuses a source's prior
 *     id from `previous` when it is still free — so the same physical device gets
 *     the same id across unplug→replug.
 */
export function allocateSyntheticIds(
	sources: readonly ProjectedModemSource[],
	usedMmIds: ReadonlySet<number>,
	previous: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
	const synthetic = sources
		.filter((s) => s.kind !== "mm-managed")
		.slice()
		.sort((a, b) => a.stableKey.localeCompare(b.stableKey));

	const result = new Map<string, number>();
	const claimed = new Set<number>();

	// Pass 1: reinstate a prior id when it is still collision-free (replug stability).
	for (const source of synthetic) {
		const prior = previous.get(source.stableKey);
		if (
			prior !== undefined &&
			prior >= SYNTHETIC_ID_BASE &&
			!usedMmIds.has(prior) &&
			!claimed.has(prior)
		) {
			result.set(source.stableKey, prior);
			claimed.add(prior);
		}
	}

	// Pass 2: assign the lowest free id ≥ base to any source still unallocated.
	for (const source of synthetic) {
		if (result.has(source.stableKey)) {
			continue;
		}
		let id = SYNTHETIC_ID_BASE;
		while (usedMmIds.has(id) || claimed.has(id)) {
			id++;
		}
		result.set(source.stableKey, id);
		claimed.add(id);
	}

	return result;
}

/**
 * Build ONE wire entry with the EXACT field set and key ORDER of
 * `modem-status.ts::buildModemMessage` (full-status form): `status` first, then
 * `ifname, name, model?, manufacturer?, network_type, config?/no_sim, sim_lock?,
 * available_networks`. Key order is load-bearing — the byte-compat claim is a
 * `JSON.stringify` equality, so this order is asserted, not incidental.
 */
function buildWireEntry(
	source: ProjectedModemSource,
	hasGsmAutoconfig: boolean,
): WireModemEntry {
	const entry: WireModemEntry = { status: source.status };

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
	if (source.config) {
		entry.config = resolveWireConfig(source.config, hasGsmAutoconfig);
	} else {
		entry.no_sim = true;
	}
	if (source.simLock) {
		entry.sim_lock = source.simLock;
	}
	entry.available_networks = source.availableNetworks ?? {};

	return entry;
}

/**
 * Project a normalized source set into the legacy numeric wire message. mm-managed
 * devices key by their MM runtime id; router/unmanaged devices key by a
 * collision-checked, replug-stable synthetic id (≥ {@link SYNTHETIC_ID_BASE}).
 */
export function projectModemWire(
	sources: readonly ProjectedModemSource[],
	deps: ProjectModemWireDeps,
): ProjectModemWireResult {
	const usedMmIds = new Set<number>();
	for (const source of sources) {
		if (source.kind === "mm-managed" && source.runtimeId !== null) {
			usedMmIds.add(source.runtimeId);
		}
	}

	const syntheticIds = allocateSyntheticIds(
		sources,
		usedMmIds,
		deps.previousSyntheticIds,
	);

	const message: WireModemsMessage = {};
	for (const source of sources) {
		const id =
			source.kind === "mm-managed" && source.runtimeId !== null
				? source.runtimeId
				: syntheticIds.get(source.stableKey);
		if (id === undefined) {
			continue;
		}
		message[String(id)] = buildWireEntry(source, deps.hasGsmAutoconfig);
	}

	return { message, syntheticIds };
}
