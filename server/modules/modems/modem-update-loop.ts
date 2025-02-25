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

/* Checks every {modemUpdateInterval}ms for new modems on the modem manager (mmcli) and updates the status of existing ones. */

import { logger } from "../../helpers/logger.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnGetFields,
	nmConnect,
} from "../network/network-manager.ts";

import { setup } from "../setup.ts";

import { getGsmConnections, resetGsmConnections } from "./gsm-connections.ts";
import {
	type ModemId,
	type ModemInfo,
	type SimInfo,
	mmConvertAccessTech,
	mmConvertNetworkType,
	mmConvertNetworkTypes,
	mmGetModem,
	mmGetSim,
	mmList,
} from "./mmcli.ts";
import { broadcastModems } from "./modem-status.ts";
import {
	type Modem,
	type ModemConfig,
	getModem,
	getModems,
	removeModem,
	setModem,
} from "./modems-state.ts";

export type ModemStatus = {
	connection: string;
	network?: string;
	network_type: string; // e.g. '3g4g'
	signal: number; // 0-100
	roaming: boolean;
};

const modemUpdateInterval = 10_000;

const MODEM_IS_NEW = Symbol("MODEM_IS_NEW");

async function modemGetConfig(
	modemInfo: ModemInfo,
	simInfo: SimInfo,
): Promise<ModemConfig | undefined> {
	const modemId = modemInfo["modem.generic.device-identifier"];
	const simId = simInfo["sim.properties.iccid"];
	const operatorId = simInfo["sim.properties.operator-code"];

	const gsmConnections = await getGsmConnections();

	if (gsmConnections.byDevice[modemId]?.[simId]) {
		const ci = gsmConnections.byDevice[modemId][simId];
		logger.debug(`Found NM connection ${ci.uuid} for modem ${modemId}`);
		return {
			conn: ci.uuid,
			autoconfig: ci.autoconfig === true,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
	}

	if (operatorId && gsmConnections.byOperator[operatorId]) {
		// Copy the settings from an existing config for the same operator
		const ci = gsmConnections.byOperator[operatorId];
		return {
			autoconfig: ci.autoconfig === true,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
	}

	// New connection profile
	return {
		autoconfig: true,
		apn: "internet",
		username: "",
		password: "",
		roaming: true,
		network: "",
	};
}

async function connectModemIfNeededAndPossible(modem: Modem, modemId: number) {
	// If the modem has an inactive NM connection and isn't otherwise busy, then try to bring it up
	if (
		!modem.inhibit &&
		!modem.is_scanning &&
		(modem.status?.connection === "registered" ||
			modem.status?.connection === "enabled") &&
		modem.config?.conn
	) {
		// Don't try to activate NM connections that are already active
		const nmConnection = await nmConnGetFields(modem.config.conn, [
			"GENERAL.STATE",
		] as const);
		if (nmConnection?.length === 1) {
			logger.info(
				`Trying to bring up connection ${modem.config.conn} for modem ${modemId}...`,
			);
			nmConnect(modem.config.conn);
		}
	}
}

function buildModemStatus(
	modemInfo: Readonly<ModemInfo>,
	modem: Readonly<Modem>,
): ModemStatus {
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

	return { connection, network, network_type, signal, roaming };
}

function applyAutoconfigToModemConfig(
	config: ModemConfig,
	autoConfig: boolean,
) {
	if (autoConfig) {
		config.apn = "";
		config.username = "";
		config.password = "";
	} else {
		config.autoconfig = false;
	}
}

export function sanitizeModemConfigForNetworkManager(config: ModemConfig) {
	const autoConfig = Boolean(setup.has_gsm_autoconfig && config.autoconfig);

	const fields: NetworkManagerConnectionModemConfig = {
		"gsm.apn": config.apn || "", // FIXME: This should be the empty but bun currently drops empty arguments
		"gsm.username": config.username || "", // FIXME: This should be the empty but bun currently drops empty arguments
		"gsm.password": config.password || "", // FIXME: This should be the empty but bun currently drops empty arguments
		"gsm.password-flags": !config.password ? "4" : "0",
		"gsm.home-only": config.roaming ? "no" : "yes",
		"gsm.network-id": config.roaming ? config.network : "",
		"gsm.auto-config": autoConfig ? "yes" : "no",
	};

	applyAutoconfigToModemConfig(config, autoConfig);

	return fields;
}

async function addConnectionForModem(
	modemInfo: ModemInfo,
	simInfo: SimInfo,
	config: ModemConfig,
) {
	const modemId = modemInfo["modem.generic.device-identifier"];
	const simId = simInfo["sim.properties.iccid"];
	const operatorId = simInfo["sim.properties.operator-code"];

	// The NM connection doesn't exist yet, create it
	//const autoconnect = (modemInfo['modem.3gpp.registration-state'] != 'idle') ? 'yes' : 'no';
	const nmConfig: NetworkManagerConnection = {
		type: "gsm",
		ifname: "", // can be empty for gsm connections, matching by device-id and sim-id // FIXME: This should be the empty but bun currently drops empty arguments
		autoconnect: "yes",
		"connection.autoconnect-retries": 2,
		"ipv6.method": "ignore",
		"gsm.device-id": modemId,
		"gsm.sim-id": simId,
		...sanitizeModemConfigForNetworkManager(config),
	};
	if (operatorId) {
		nmConfig["gsm.sim-operator-id"] = operatorId;
	}

	const uuid = await nmConnAdd(nmConfig);
	if (uuid) {
		config.conn = uuid;
		logger.debug(`Created NM connection ${uuid} for ${modemId}`, config);
	}
}

async function registerModem(id: number) {
	if (getModem(id)) {
		throw new Error(`Trying to register existing modem id ${id}`);
	}

	// Get all the required info for the modem
	const modemInfo = await mmGetModem(id);
	if (!modemInfo) {
		logger.error(`Failed to get modem info for modem ${id}`);
		return;
	}

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
				config = await modemGetConfig(modemInfo, simInfo);

				if (config) {
					await addConnectionForModem(modemInfo, simInfo, config);
				}
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
	if (!ifname) {
		logger.error(`Failed to find the network interface for modem ${id}`);
		return;
	}

	// Find the current network type
	const networkType = modemInfo["modem.generic.current-modes"]
		? mmConvertNetworkType(modemInfo["modem.generic.current-modes"])
		: null;

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
	if (partialImei) {
		partialImei = partialImei.substring(partialImei.length - 5);
	}
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
			active: networkType?.label ?? null,
		},
		config: config,
	};

	modem.status = buildModemStatus(modemInfo, modem);

	setModem(id, modem);
}

async function updateModem(modemId: ModemId) {
	const modem = getModem(modemId);
	if (!modem) {
		try {
			logger.debug("Trying to register modem", modemId);
			await registerModem(modemId);
			logger.debug(
				"Registered modems",
				JSON.stringify(getModem(modemId), undefined, 2),
			);
			return MODEM_IS_NEW;
		} catch (e) {
			logger.error(`Failed to register modem ${modemId}`);
			throw e;
		}
	}

	// The modem is already registered, unmark it for deletion
	modem.removed = undefined;

	const modemInfo = await mmGetModem(modemId);
	if (!modemInfo) {
		logger.error(`Failed to get modem info for modem ${modemId}`);
		return;
	}

	modem.status = buildModemStatus(modemInfo, modem);
	await connectModemIfNeededAndPossible(modem, modemId);
}

export async function updateModems() {
	const modems = getModems();
	for (const modem of Object.values(modems)) {
		modem.removed = true;
	}
	const modemList = (await mmList()) || [];

	// NM gsm connections to match with new modems - filled on demand if any new modems have been found
	resetGsmConnections();
	const newModems: Record<number, true> = {};

	for (const m of modemList) {
		const result = await updateModem(m);
		if (result === MODEM_IS_NEW) {
			newModems[m] = true;
		}
	}

	// If any modems were removed, delete them
	for (const m in modems) {
		if (modems[m]?.removed) {
			logger.warn(`Modem ${m} removed`);
			removeModem(Number(m));
		}
	}

	broadcastModems(newModems);

	setTimeout(updateModems, modemUpdateInterval);
}
