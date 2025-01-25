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

/*
  ModemManager / NetworkManager based modem management

  Structs:

  Modem list <modems>:
  {
    MMid: <modem>
  }

  Individual modem struct <modem>:
  {
    ifname: wwan0,
    name: "QUECTEL Broadband Module - 00000 | VINAPHONE", <Model - partial IMEI | SIM provider>
    network_type: {
      supported: ['2g', 3g', '3g4g', '4g'],
      config: '3g4g',
    },
    is_scanning: true/undefined,
    inhibit: true/undefined, // don't bring up automatically
    config: {
      conn: 'nmUuid',
      autoconfig: true/false, // only if(setup.has_gsm_autoconfig)
      apn: '',
      username: '',
      password: '',
      roaming: true/false,
      network: ''
    },
    status: {
      state: 'connecting', 'connected', 'disconnected', etc
      network: '<GSM NETWORK NAME>',
      network_type: 3g/4g,
      signal: 0-100,
      roaming: true/false,
    }
    available_networks: undefined or {
      'id': {
        name: '',
        availability: 'available', 'forbidden', etc
      }
    }
  }
*/
import fs from "node:fs";

import type WebSocket from "ws";

import { extractMessage } from "../helpers/types.ts";

import {
	type NetworkScanResult,
	mmConvertAccessTech,
	mmConvertNetworkType,
	mmConvertNetworkTypes,
	mmGetModem,
	mmGetSim,
	mmList,
	mmNetworkScan,
	mmSetNetworkTypes,
} from "./mmcli.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnGetFields,
	nmConnSetFields,
	nmConnect,
	nmConnsGet,
	nmDisconnect,
	nmcliParseSep,
} from "./network-manager.ts";
import { setup } from "./setup.ts";
import { writeTextFile } from "./text-files.ts";
import { broadcastMsg } from "./websocket-server.ts";

type ModemConfigMessage = {
	config: {
		device: number;
		roaming?: boolean;
		autoconfig?: boolean;
		apn?: unknown;
		username?: unknown;
		password?: unknown;
		network?: unknown;
		network_type?: unknown;
	};
};

type ModemScanMessage = {
	scan: {
		device: string;
	};
};

export type ModemsMessage = {
	modems: ModemConfigMessage | ModemScanMessage;
};

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

type ModemStatus = {
	connection: string;
	network?: string;
	network_type: string;
	signal: number;
	roaming: boolean;
};

export type NetworkType = {
	allowed: string;
	preferred: string;
};

type AvailableNetwork = {
	name: string;
	availability?: NetworkScanResult["availability"];
};

type Modem = {
	ifname: string;
	name: string;
	sim_network: string;
	network_type: {
		supported: Record<string, NetworkType>;
		active: string;
	};
	is_scanning?: boolean;
	inhibit?: boolean;
	config?: ModemConfig;
	status?: ModemStatus;
	available_networks?: Record<string, AvailableNetwork>;
	removed?: true;
};

export type ModemInfo = {
	"modem.generic.sim": string;
	"modem.generic.state": string;
	"modem.generic.ports": string;
	"modem.generic.model": string;
	"modem.generic.current-modes": string;
	"modem.generic.supported-modes": Array<string>;
	"modem.generic.equipment-identifier": string;
	"modem.generic.device-identifier": string;
	"modem.generic.access-technologies": Array<string>;
	"modem.generic.signal-quality.value": number;
	"modem.3gpp.operator-name"?: string;
	"modem.3gpp.registration-state"?: string;
};

export type SimInfo = {
	"sim.properties.iccid": string;
	"sim.properties.operator-code"?: string;
	"sim.properties.operator-name"?: string;
};

type ModemConfig = {
	conn?: string;
	autoconfig?: boolean;
	apn: string;
	username: string;
	password: string;
	roaming: boolean;
	network: string;
};

const GSM_OPERATORS_CACHE_FILE = "gsm_operator_cache.json";

export const modems: Record<number, Modem> = {};

let gsmOperatorsCache: Record<string, string> = {};
try {
	gsmOperatorsCache = JSON.parse(
		fs.readFileSync(GSM_OPERATORS_CACHE_FILE, "utf8"),
	);
} catch (err) {
	console.log(
		"Failed to load the persistent GSM operators cache, starting with an empty cache",
	);
}

async function gsmOperatorsAdd(id: string, name: string) {
	const cachedOperator = gsmOperatorsCache[id];

	if (!cachedOperator || cachedOperator !== name) {
		gsmOperatorsCache[id] = name;
		await writeTextFile(
			GSM_OPERATORS_CACHE_FILE,
			JSON.stringify(gsmOperatorsCache),
		);
	}
}

type GsmConnections = Awaited<ReturnType<typeof getGsmConns>>;

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

async function getGsmConns() {
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

function modemConfigSantizeToNM(config: ModemConfig) {
	const fields: NetworkManagerConnectionModemConfig = {
		"gsm.apn": config.apn,
		"gsm.username": config.username,
		"gsm.password": config.password,
		"gsm.password-flags": !config.password ? "4" : "0",
		"gsm.home-only": config.roaming ? "no" : "yes",
		"gsm.network-id": config.roaming ? config.network : "",
		"gsm.auto-config":
			setup.has_gsm_autoconfig && config.autoconfig ? "yes" : "no",
	};
	if (fields["gsm.auto-config"]) {
		config.apn = "";
		config.username = "";
		config.password = "";
	} else {
		config.autoconfig = undefined;
	}

	return fields;
}

async function modemGetConfig(
	modemInfo: ModemInfo,
	simInfo: SimInfo,
	gsmConns: GsmConnections,
) {
	if (!modemInfo || !simInfo || !gsmConns) return;

	const modemId = modemInfo["modem.generic.device-identifier"];
	const simId = simInfo["sim.properties.iccid"];
	const operatorId = simInfo["sim.properties.operator-code"];

	let config: ModemConfig;
	if (gsmConns.byDevice[modemId]?.[simId]) {
		const ci = gsmConns.byDevice[modemId][simId];
		config = {
			conn: ci.uuid,
			autoconfig: ci.autoconfig,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
		console.log(`Found NM connection ${config.conn} for modem ${modemId}`);
		return config;
	}

	if (gsmConns && operatorId && gsmConns.byOperator[operatorId]) {
		// Copy the settings from an existing config for the same operator
		const ci = gsmConns.byOperator[operatorId];
		config = {
			autoconfig: ci.autoconfig,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
	} else {
		// New connection profile
		config = {
			autoconfig: true,
			apn: "internet",
			username: "",
			password: "",
			roaming: true,
			network: "",
		};
	}

	// The NM connection doesn't exist yet, create it
	//const autoconnect = (modemInfo['modem.3gpp.registration-state'] != 'idle') ? 'yes' : 'no';
	const nmConfig: NetworkManagerConnection = {
		type: "gsm",
		ifname: "", // can be empty for gsm connections, matching by device-id and sim-id
		autoconnect: "yes",
		"connection.autoconnect-retries": 10,
		"ipv6.method": "ignore",
		"gsm.device-id": modemId,
		"gsm.sim-id": simId,
		...modemConfigSantizeToNM(config),
	};
	if (operatorId) {
		nmConfig["gsm.sim-operator-id"] = operatorId;
	}
	const uuid = await nmConnAdd(nmConfig);
	if (uuid) {
		config.conn = uuid;
		console.log(`Created NM connection ${uuid} for ${modemId}`);
		console.log(config);
	}

	return config;
}

function modemUpdateStatus(modemInfo: ModemInfo, modem: Modem) {
	// Some modems don't seem to always report the operator's name
	let network = modemInfo["modem.3gpp.operator-name"];
	if (!network && modemInfo["modem.3gpp.registration-state"] === "home") {
		network = modem.sim_network;
	}
	const network_type = mmConvertAccessTech(
		modemInfo["modem.generic.access-technologies"],
	);
	const signal = modemInfo["modem.generic.signal-quality.value"];
	const roaming = modemInfo["modem.3gpp.registration-state"] === "roaming";
	const connection = modem.is_scanning
		? "scanning"
		: modemInfo["modem.generic.state"];

	modem.status = { connection, network, network_type, signal, roaming };
}

async function modemNetworkScan(id: number) {
	const modem = modems[id];

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

async function registerModem(id: number) {
	if (modems[id]) {
		throw new Error(`Trying to register existing modem id ${id}`);
	}

	// Get all the required info for the modem
	const modemInfo = await mmGetModem(id);
	if (!modemInfo) return;

	let simInfo: SimInfo | undefined;
	let config: ModemConfig | undefined;
	if (modemInfo["modem.generic.sim"]) {
		const simId = modemInfo["modem.generic.sim"].match(
			/\/org\/freedesktop\/ModemManager1\/SIM\/(\d+)/,
		) as [string, string] | null;

		if (simId) {
			simInfo = await mmGetSim(Number.parseInt(simId[1], 10));

			// If a SIM is present, try to find a matching NM connection or create one
			if (simInfo) {
				if (!gsmConns) {
					gsmConns = await getGsmConns();
				}
				config = await modemGetConfig(modemInfo, simInfo, gsmConns);
			}
		}
	}

	// Find the network interface name
	let ifname: string | undefined;
	for (const port of modemInfo["modem.generic.ports"]) {
		const pattern = / \(net\)$/;
		if (port.match(pattern)) {
			ifname = port.replace(pattern, "");
			break;
		}
	}
	if (!ifname) return;

	// Find the current network type
	const networkType = mmConvertNetworkType(
		modemInfo["modem.generic.current-modes"],
	);

	// Find the supported network types
	const networkTypes = mmConvertNetworkTypes(
		modemInfo["modem.generic.supported-modes"],
	);

	// Make sure the current mode is on the list
	if (networkType && !networkTypes[networkType.label]) {
		networkTypes[networkType.label] = {
			allowed: networkType.allowed,
			preferred: networkType.preferred,
		};
	}

	let partialImei = modemInfo["modem.generic.equipment-identifier"];
	partialImei = partialImei.substr(partialImei.length - 5, 5);
	const hwName = `${modemInfo["modem.generic.model"]} - ${partialImei}`;

	let simNetwork = "<NO SIM>";
	if (simInfo) {
		simNetwork = simInfo["sim.properties.operator-name"] || "Unknown";
	}

	const modem: Modem = {
		ifname: ifname,
		name: `${hwName} | ${simNetwork}`,
		sim_network: simNetwork,
		network_type: {
			supported: networkTypes,
			active: networkType.label,
		},
		config: config,
	};
	modemUpdateStatus(modemInfo, modem);

	modems[id] = modem;
}

function modemGetAvailableNetworks(modem: Modem) {
	if (!modem.config || modem.config.network === "")
		return modem.available_networks || {};

	const networks = Object.assign({}, modem.available_networks);
	if (!modem.available_networks) {
		const name =
			gsmOperatorsCache[modem.config.network] ||
			`Operator ID ${modem.config.network}`;
		networks[modem.config.network] = { name };
	} else if (!modem.available_networks[modem.config.network]) {
		networks[modem.config.network] = {
			name: "Test",
			availability: "unavailable",
		};
	}

	return networks;
}

type ModemsResponseModemStatus = {
	connection: string;
	network?: string;
	network_type: string;
	signal: number;
	roaming: boolean;
};

type ModemResponseModemBase = {
	status?: ModemsResponseModemStatus;
};

type ModemsResponseModemFull = {
	ifname: string;
	name: string;
	network_type: {
		supported: Array<string>;
		active: string;
	};
	config?: {
		autoconfig?: boolean;
		apn: string;
		username: string;
		password: string;
		roaming: boolean;
		network: string;
	};
	no_sim?: boolean;
	available_networks?: Record<string, AvailableNetwork>;
};

type ModemsResponseMessageEntry =
	| ModemResponseModemBase
	| (ModemResponseModemBase & ModemsResponseModemFull);

type ModemsResponseMessage = Record<string, ModemsResponseMessageEntry>;

export function modemsBuildMsg(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	const msg: ModemsResponseMessage = {};
	for (const i in modems) {
		const modem = modems[i];
		if (!modem?.status) continue;

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

		const full = modemsFullState === undefined || modemsFullState[i];
		if (full) {
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
					autoconfig: setup.has_gsm_autoconfig
						? modem.config.autoconfig
						: undefined,
				};
			} else {
				fullState.no_sim = true;
			}
			fullState.available_networks = modemGetAvailableNetworks(modem);

			Object.assign(entry, fullState);
		}
	}

	return msg;
}

function broadcastModems(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	broadcastMsg("status", { modems: modemsBuildMsg(modemsFullState) });
}

function modemBuildAvailableNetworksMessage(id: number) {
	const msg: Record<
		string,
		{ available_networks?: Record<string, AvailableNetwork> }
	> = {};

	for (const i in modems) {
		const modem = modems[i];
		if (!modem) continue;

		msg[i] = {};
		if (String(id) === String(i)) {
			msg[i].available_networks = modemGetAvailableNetworks(modem);
		}
	}

	return msg;
}

function broadcastModemAvailableNetworks(id: number) {
	broadcastMsg("status", { modems: modemBuildAvailableNetworksMessage(id) });
}

// Global variable, to allow fetching once in updateModems() and reuse in registerModem()
let gsmConns: GsmConnections | undefined;

export async function updateModems() {
	for (const m of Object.values(modems)) {
		m.removed = true;
	}
	const modemList = (await mmList()) || [];

	// NM gsm connections to match with new modems - filled on demand if any new modems have been found
	gsmConns = undefined;
	const newModems: Record<number, true> = {};

	for (const m of modemList) {
		const modem = modems[m];
		if (!modem) {
			try {
				await registerModem(m);
				newModems[m] = true;
				console.log(JSON.stringify(modems[m], undefined, 2));
			} catch (e) {
				console.log(`Failed to register modem ${m}`);
			}
			continue;
		}

		// The modem is already registered, unmark it for deletion
		modem.removed = undefined;

		const modemInfo = await mmGetModem(m);
		if (!modemInfo) continue;

		modemUpdateStatus(modemInfo, modem);

		// If the modem has an inactive NM connection and isn't otherwise busy, then try to bring it up
		if (
			!modem.inhibit &&
			!modem.is_scanning &&
			modem.status &&
			(modem.status.connection === "registered" ||
				modem.status.connection === "enabled") &&
			modem.config &&
			modem.config.conn
		) {
			// Don't try to activate NM connections that are already active
			const nmConnection = await nmConnGetFields(modem.config.conn, [
				"GENERAL.STATE",
			] as const);
			if (nmConnection?.length === 1) {
				console.log(
					`Trying to bring up connection ${modem.config.conn} for modem ${m}...`,
				);
				nmConnect(modem.config.conn);
			}
		}
	} // for (const m of modemList)

	// If any modems were removed, delete them
	for (const m in modems) {
		if (modems[m]?.removed) {
			console.log(`Modem ${m} removed`);
			delete modems[m];
		}
	}

	broadcastModems(newModems);

	setTimeout(updateModems, 1000);
}

async function handleModemConfig(
	conn: WebSocket,
	msg: ModemConfigMessage["config"],
) {
	if (!msg.device || !modems[msg.device]) {
		console.log(`Ignoring modem config for unknown modem ${msg.device}`);
		return;
	}

	const modem = modems[msg.device];
	if (!modem) return;

	if (!modem.config || !modem.config.conn) {
		console.log(`Ignoring modem config for unconfigured modem ${msg.device}`);
		console.log(modem.config);
		return;
	}
	const connUuid = modem.config.conn;
	if (!connUuid) {
		console.log(
			`Ignoring modem config for modem ${msg.device} with no connection UUID`,
		);
		return;
	}

	// Ensure the configuration message has all the required fields
	if (
		(msg.roaming !== true && msg.roaming !== false) ||
		(msg.autoconfig !== true && msg.autoconfig !== false) ||
		typeof msg.apn !== "string" ||
		typeof msg.username !== "string" ||
		typeof msg.password !== "string" ||
		typeof msg.network !== "string" ||
		typeof msg.network_type !== "string"
	) {
		console.log(`Received invalid configuration for modem ${msg.device}`);
		console.log(msg);
		return;
	}

	// Ensure the selected network type is supported
	const networkType = modem.network_type.supported[msg.network_type];
	if (!networkType) {
		console.log(
			`Received invalid network type ${msg.network_type} for modem ${msg.device}`,
		);
		return;
	}

	// Only allow automatic network selection, the network previously saved, or a network included in the scan results
	if (
		msg.network &&
		msg.network !== "" &&
		msg.network !== modem.config.network &&
		(!modem.available_networks || !modem.available_networks[msg.network])
	) {
		console.log(
			`Received unavailable network ${msg.network} for modem ${msg.device}`,
		);
		return;
	}

	// If a new network is selected, write it to the GSM operators cache
	const newNetwork =
		msg.network &&
		msg.network !== "" &&
		modem.available_networks &&
		modem.available_networks[msg.network];
	if (newNetwork) {
		gsmOperatorsAdd(msg.network, newNetwork.name);
	}

	// Temporary config that we'll attempt to write
	const updatedConfig: ModemConfig = {
		autoconfig: msg.autoconfig,
		apn: msg.apn,
		username: msg.username,
		password: msg.password,
		roaming: msg.roaming,
		network: msg.network,
	};
	// This also modifies config in place to clear apn/username/password if autoconfig is set
	const result = await nmConnSetFields(
		connUuid,
		modemConfigSantizeToNM(updatedConfig),
	);
	if (result) {
		// This preserves the 'conn' UUID value
		Object.assign(modem.config, updatedConfig);
	} else {
		console.log(
			`Failed to update NM connection ${modem.config.conn} for modem ${msg.device} to:`,
		);
		console.log(updatedConfig);
	}

	// Bring the connection down to reload the settings, and set the network types, if needed
	modem.inhibit = true;
	await nmDisconnect(connUuid);
	if (msg.network_type !== modem.network_type.active) {
		const result = await mmSetNetworkTypes(
			msg.device,
			networkType.allowed,
			networkType.preferred,
		);
		if (result) {
			modem.network_type.active = msg.network_type;
		}
	}
	modem.inhibit = undefined;

	// Send the updated settings to the clients
	const updatedModem: Record<string, true> = {};
	updatedModem[msg.device] = true;
	broadcastModems(updatedModem);
}

async function handleModemScan(conn: WebSocket, msg: ModemScanMessage["scan"]) {
	const deviceId = Number.parseInt(msg.device, 10);
	if (!msg || !modems[deviceId]) return;

	await modemNetworkScan(deviceId);
}

export function handleModems(conn: WebSocket, msg: ModemsMessage["modems"]) {
	for (const type in msg) {
		switch (type) {
			case "config":
				handleModemConfig(
					conn,
					extractMessage<ModemConfigMessage, typeof type>(msg, type),
				);
				break;
			case "scan":
				handleModemScan(
					conn,
					extractMessage<ModemScanMessage, typeof type>(msg, type),
				);
				break;
		}
	}
}
