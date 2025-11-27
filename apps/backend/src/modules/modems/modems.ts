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

/*
  ModemManager / NetworkManager based modem management
*/

import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { extractMessage } from "../../helpers/types.ts";

import {
	type ConnectionUUID,
	nmConnSetFields,
	nmDisconnect,
} from "../network/network-manager.ts";

import { setGsmOperatorName } from "./gsm-operators-cache.ts";
import { mmSetNetworkTypes } from "./mmcli.ts";
import { modemNetworkScan } from "./modem-network-scan.ts";
import { broadcastModems } from "./modem-status.ts";
import { sanitizeModemConfigForNetworkManager } from "./modem-update-loop.ts";
import { getModem, type ModemConfig } from "./modems-state.ts";

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

async function updateModemConnection(
	connectionUuid: ConnectionUUID,
	config: ModemConfig,
) {
	// This also modifies config in place to clear apn/username/password if autoconfig is set
	const nmConfig = sanitizeModemConfigForNetworkManager(config);

	return await nmConnSetFields(connectionUuid, nmConfig);
}

async function handleModemConfig(
	_conn: WebSocket,
	msg: ModemConfigMessage["config"],
) {
	if (!msg.device) {
		logger.info("Ignoring modem config for unknown modem (no id)");
		return;
	}

	const modem = getModem(msg.device);
	if (!modem) {
		logger.info(`Ignoring modem config for unknown modem ${msg.device}`);
		return;
	}

	if (!modem.config || !modem.config.conn) {
		logger.info(`Ignoring modem config for unconfigured modem ${msg.device}`);
		logger.debug("Modem config", modem.config);
		return;
	}

	const connUuid = modem.config.conn;
	if (!connUuid) {
		logger.info(
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
		logger.error(`Received invalid configuration for modem ${msg.device}`);
		logger.debug("Invalid configuration message", msg);
		return;
	}

	// Ensure the selected network type is supported
	const networkType = modem.network_type.supported[msg.network_type];
	if (!networkType) {
		logger.error(
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
		logger.warn(
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
		setGsmOperatorName(msg.network, newNetwork.name);
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
	const result = await updateModemConnection(connUuid, updatedConfig);
	if (result) {
		// This preserves the 'conn' UUID value
		Object.assign(modem.config, updatedConfig);
	} else {
		logger.error(
			`Failed to update NM connection ${modem.config.conn} for modem ${msg.device} to:`,
		);
		logger.debug("Failed modem config update", updatedConfig);
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
	broadcastModems({ [msg.device]: true });
}

async function handleModemScan(
	_conn: WebSocket,
	msg: ModemScanMessage["scan"],
) {
	const modemId = Number.parseInt(msg.device, 10);
	if (!msg || !getModem(modemId)) return;

	await modemNetworkScan(modemId);
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
