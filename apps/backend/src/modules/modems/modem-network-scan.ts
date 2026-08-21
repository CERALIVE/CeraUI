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

import { nmDisconnect } from "../network/network-manager.ts";

import { broadcastMsg } from "../ui/websocket-server.ts";

import { mmNetworkScan } from "./mmcli.ts";
import {
	type AvailableNetwork,
	getAvailableNetworksForModem,
	getModem,
	getModemIds,
	type Modem,
} from "./modems-state.ts";

function modemBuildAvailableNetworksMessage(id: number) {
	const msg: Record<
		string,
		{ available_networks?: Record<string, AvailableNetwork> }
	> = {};

	const modemIds = getModemIds();
	for (const modemId of modemIds) {
		const modem = getModem(modemId);
		if (!modem) continue;

		msg[modemId] = {};
		if (id === modemId) {
			msg[modemId].available_networks = getAvailableNetworksForModem(modem);
		}
	}

	return msg;
}

function broadcastModemAvailableNetworks(id: number) {
	broadcastMsg("status", { modems: modemBuildAvailableNetworksMessage(id) });
}

/** What a scan did — never collapsed into a bare success. */
export type ModemNetworkScanOutcome =
	| { readonly ok: true; readonly count: number }
	| {
			readonly ok: false;
			readonly reason: "timed_out" | "failed" | "already_scanning";
	  };

/**
 * Clear the in-flight marker on whichever modem object is CURRENTLY in the
 * state map.
 *
 * The captured `modem` reference is not that object for long: a status refresh
 * builds a NEW `Modem` (`mergeRefreshedModem` — immutable replace, so the T11
 * diff can detect a change by value) and spreads the previous one into it, so
 * `is_scanning` is carried FORWARD onto the replacement while a `delete` on the
 * captured reference mutates an object nothing reads any more.
 *
 * Board-measured on `ceralive2` (2026-08-18): one scan left the flag latched for
 * the process lifetime — every later scan was refused `already_scanning` and the
 * row reported `connection: "scanning"` forever, because `buildModemStatus`
 * derives that label from the same flag. Re-reading the map is what makes the
 * clear land on the object the next scan will actually test.
 */
function clearScanningMarker(id: number): void {
	const live = getModem(id);
	if (live !== undefined) delete live.is_scanning;
}

/**
 * Run a 3GPP network scan, and report what it actually did.
 *
 * The return value exists because the caller has to be able to REFUSE. A scan
 * that never completed used to be indistinguishable from one that found
 * nothing: `mmNetworkScan` answered `undefined` for both, this function
 * rebroadcast the previous (usually empty) list either way, and the RPC above it
 * always replied `{success:true}`. Board-measured on `ceralive2` — the scan was
 * killed at 30 s by its own caller and the operator was told it had succeeded,
 * which is the "scan fails with no error" report this closes.
 */
export async function modemNetworkScan(
	id: number,
): Promise<ModemNetworkScanOutcome> {
	const modem = getModem(id);

	if (!modem?.config || !modem.status) return { ok: false, reason: "failed" };
	if (modem.is_scanning) return { ok: false, reason: "already_scanning" };

	modem.is_scanning = true;

	let outcome: Awaited<ReturnType<typeof mmNetworkScan>>;
	try {
		if (modem.config?.conn) {
			await nmDisconnect(modem.config.conn);
		}
		outcome = await mmNetworkScan(id);
	} finally {
		clearScanningMarker(id);
	}

	/* A scan that produced nothing still resends the old results so clients learn
     it finished — but its REASON is returned rather than swallowed. */
	if (!outcome.ok) {
		broadcastModemAvailableNetworks(id);
		return { ok: false, reason: outcome.reason };
	}
	const results = outcome.results;

	/* Some (but not all) modems return separate results for each network type (3G, 4G, etc),
     but we merge them as we have a separate network type setting */
	const availableNetworks: Modem["available_networks"] = {};
	for (const r of results) {
		const code = r["operator-code"];
		/* Normalise the raw mmcli availability onto the wire contract
       (available | unavailable | absent): 'current' becomes 'available' as
       these cached results may be shown after switching networks, a
       'forbidden' PLMN is surfaced as 'unavailable', and 'unknown' drops the
       field entirely. */
		switch (r.availability) {
			case "current":
				r.availability = "available";
				break;
			case "forbidden":
				r.availability = "unavailable";
				break;
			case "unknown":
				delete r.availability;
				break;
		}

		if (availableNetworks[code]) {
			if (
				r.availability === "available" &&
				availableNetworks[code].availability !== "available"
			) {
				availableNetworks[code].availability = "available";
			}
		} else {
			availableNetworks[code] = {
				name: r["operator-name"],
				availability: r.availability,
			};
		}
	}

	modem.available_networks = availableNetworks;
	broadcastModemAvailableNetworks(id);
	return { ok: true, count: Object.keys(availableNetworks).length };
}
