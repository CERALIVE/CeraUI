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
 * Production dependency wiring for `modem_shadow` (Phase B).
 *
 * Mirrors `dbus-backend.ts`: the ONLY place that touches `@ceralive/modem-control`
 * (the read-only observer + the D-Bus transport). Lazily imported by
 * `startModemShadowIfEnabled()` so neither the transport nor the observer graph ever
 * loads on the default mmcli path.
 *
 * Both mappers are secret-dropping: the mmcli mapper copies a non-secret allowlist
 * (never APN/username/password/PIN), and the observation mapper keys on the
 * equipment/slot id — never the subscription id (ICCID/EID).
 */

import { createMmDbusObserver } from "@ceralive/modem-control";
import { createDbusTransport } from "@ceralive/modem-control/transport";

import { getModems } from "../modems/modems-state.ts";
import type { ShadowModeDeps } from "./shadow.ts";
import {
	mmcliModemToShadowState,
	observationRowToShadowState,
	type ShadowModemState,
} from "./shadow-divergence.ts";

const SYSTEM_BUS_ADDRESS = "unix:path=/var/run/dbus/system_bus_socket";

/** Coarse, non-secret signal bucket from mmcli's 0–100 quality. */
function signalBucket(signal: number | undefined): string | undefined {
	if (signal === undefined || Number.isNaN(signal)) return undefined;
	if (signal <= 0) return "none";
	if (signal < 34) return "low";
	if (signal < 67) return "mid";
	return "high";
}

/** Snapshot the live mmcli-reported modems as normalized, non-secret states. */
function readMmcliStates(): readonly ShadowModemState[] {
	const modems = getModems();
	return Object.values(modems).map((modem) =>
		mmcliModemToShadowState({
			id: modem.ifname,
			present: modem.removed !== true,
			registration: modem.status?.connection,
			signalBucket: signalBucket(modem.status?.signal),
			operatorName: modem.status?.network ?? modem.sim_network,
			networkType:
				modem.status?.network_type ?? modem.network_type.active ?? undefined,
			simPresent:
				modem.sim_lock !== undefined || (modem.sim_network?.length ?? 0) > 0,
		}),
	);
}

/** Build the production shadow deps (system-bus observer + live mmcli snapshot). */
export function buildProductionShadowDeps(): ShadowModeDeps {
	return {
		createTransport: () =>
			createDbusTransport({
				busAddress: process.env.DBUS_SYSTEM_BUS_ADDRESS ?? SYSTEM_BUS_ADDRESS,
			}),
		createObserver: (transport) => createMmDbusObserver({ transport }),
		readMmcliStates,
		mapObservation: (list) =>
			list.rows.map((row) => observationRowToShadowState(row)),
	};
}
