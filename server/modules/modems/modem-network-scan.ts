/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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
	type Modem,
	getAvailableNetworksForModem,
	getModem,
	getModemIds,
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

export async function modemNetworkScan(id: number) {
	const modem = getModem(id);

	if (!modem || !modem.config || !modem.status || modem.is_scanning) return;

	modem.is_scanning = true;

	if (modem.config?.conn) {
		await nmDisconnect(modem.config.conn);
	}
	const results = await mmNetworkScan(id);

	modem.is_scanning = undefined;

	/* Even if no new results are returned, resend the old ones
     to inform the clients that the scan was completed */
	if (!results) {
		broadcastModemAvailableNetworks(id);
		return;
	}

	/* Some (but not all) modems return separate results for each network type (3G, 4G, etc),
     but we merge them as we have a separate network type setting */
	const availableNetworks: Modem["available_networks"] = {};
	for (const r of results) {
		const code = r["operator-code"];
		/* We rewrite 'current' to 'available' as these results are cached
       and could be shown even after switching to a different network.
       We remove the availability info if 'unknown' */
		switch (r.availability) {
			case "current":
				r.availability = "available";
				break;
			case "unknown":
				r.availability = undefined;
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
}
