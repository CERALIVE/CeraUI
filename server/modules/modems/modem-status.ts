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

import { invariant } from "../../helpers/invariant.ts";

import { setup } from "../setup.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

import type { ModemId } from "./mmcli.ts";
import {
	type AvailableNetwork,
	type Modem,
	type ModemConfig,
	getAvailableNetworksForModem,
	getModem,
	getModemIds,
} from "./modems-state.ts";

type ModemsResponseModemStatus = {
	connection: string;
	network?: string;
	network_type: string;
	signal: number;
	roaming: boolean;
};

export type ModemsResponseModemBase = {
	status?: ModemsResponseModemStatus;
};

export type ModemsResponseModemFull = ModemsResponseModemBase & {
	ifname: string;
	name: string;
	network_type: {
		supported: Array<string>;
		active: string | null;
	};
	config?: Pick<
		ModemConfig,
		"apn" | "username" | "password" | "roaming" | "network" | "autoconfig"
	>;
	no_sim?: true;
	available_networks?: Record<string, AvailableNetwork>;
};

export type ModemsResponseMessageEntry =
	| ModemsResponseModemBase
	| ModemsResponseModemFull;

type ModemsResponseMessage = Record<string, ModemsResponseMessageEntry>;

function buildModemMessage(
	modem: Modem,
	modemsFullState: Record<number, true> | undefined,
	modemId: ModemId,
) {
	invariant(modem.status !== undefined, "Modem status is missing");

	const status: ModemsResponseMessageEntry["status"] = {
		connection: modem.status.connection,
		network: modem.status.network,
		network_type: modem.status.network_type,
		signal: modem.status.signal,
		roaming: modem.status.roaming,
	};

	const entry: ModemsResponseMessageEntry = {
		status,
	};

	const sendFullStatus =
		modemsFullState === undefined || modemsFullState[modemId];
	if (sendFullStatus) {
		const fullState: ModemsResponseModemFull = {
			ifname: modem.ifname,
			name: modem.name,
			network_type: {
				supported: Object.keys(modem.network_type.supported),
				active: modem.network_type.active,
			},
		};

		if (modem.config) {
			fullState.config = {
				apn: modem.config.apn,
				username: modem.config.username,
				password: modem.config.password,
				roaming: modem.config.roaming,
				network: modem.config.network,
				autoconfig: setup.has_gsm_autoconfig && modem.config.autoconfig,
			};
		} else {
			fullState.no_sim = true;
		}
		fullState.available_networks = getAvailableNetworksForModem(modem);

		Object.assign(entry, fullState);
	}
	return entry;
}

export function buildModemsMessage(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	const msg: ModemsResponseMessage = {};
	const modemIds = getModemIds();
	for (const modemId of modemIds) {
		const modem = getModem(modemId);
		if (modem?.status) {
			msg[modemId] = buildModemMessage(modem, modemsFullState, modemId);
		}
	}
	return msg;
}

export function broadcastModems(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	broadcastMsg("status", { modems: buildModemsMessage(modemsFullState) });
}
