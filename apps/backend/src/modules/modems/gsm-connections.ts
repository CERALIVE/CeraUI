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

import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import { setup } from "../setup.ts";

type GsmConnection = {
	state: string;
	uuid: string;
	deviceId: string;
	simId: string;
	operatorId: string;
	apn: string;
	username: string;
	password: string;
	roaming: boolean;
	network: string;
	autoconfig?: boolean;
};

export type GsmConnections = {
	byDevice: Record<string, Record<string, GsmConnection>>;
	byOperator: Record<string, GsmConnection>;
	byUuid: Record<string, GsmConnection>;
};

const gsmConnectionFields = [
	"gsm.device-id",
	"gsm.sim-id",
	"gsm.sim-operator-id",
	"gsm.apn",
	"gsm.username",
	"gsm.password",
	"gsm.home-only",
	"gsm.network-id",
] as const;

// Global variable, to allow fetching once in updateModems() and reuse in registerModem()
export let gsmConnections: GsmConnections | undefined;

async function readGsmConnections() {
	const byDevice: Record<string, Record<string, GsmConnection>> = {};
	const byOperator: Record<string, GsmConnection> = {};
	const byUuid: Record<string, GsmConnection> = {};

	const conns = (await nmConnsGet("uuid,type,state")) as Array<string>;
	for (const c of conns) {
		const [uuid, type, state] = nmcliParseSep(c) as [string, string, string];

		if (type !== "gsm") continue;

		const connInfo = await nmConnGetFields(
			uuid,
			setup.has_gsm_autoconfig
				? ([...gsmConnectionFields, "gsm.auto-config"] as const)
				: gsmConnectionFields,
		);
		if (connInfo === undefined) continue;

		const conn: GsmConnection = {
			state,
			uuid,
			deviceId: connInfo[0],
			simId: connInfo[1],
			operatorId: connInfo[2],
			apn: connInfo[3],
			username: connInfo[4],
			password: connInfo[5],
			roaming: connInfo[6] === "no",
			network: connInfo[7],
			autoconfig: setup.has_gsm_autoconfig ? connInfo[8] === "yes" : undefined,
		};

		byUuid[uuid] = conn;

		if (conn.deviceId && conn.simId) {
			if (!byDevice[conn.deviceId]) {
				byDevice[conn.deviceId] = {};
			}
			// biome-ignore lint/style/noNonNullAssertion: ensured to be defined above
			byDevice[conn.deviceId]![conn.simId] = conn;
		}

		if (conn.operatorId) {
			byOperator[conn.operatorId] = conn;
		}
	}

	return { byDevice, byOperator, byUuid };
}

export async function getGsmConnections() {
	if (!gsmConnections) {
		gsmConnections = await readGsmConnections();
	}

	return gsmConnections;
}

export function resetGsmConnections() {
	gsmConnections = undefined;
}
