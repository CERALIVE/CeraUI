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
  Modem update loop — event-driven presence + retained status poll (T17).

  HARD CUTOVER from the old always-on 10s self-recursive `setTimeout` loop:

  - Modem ADD / REMOVE + registration changes are driven by monitor events
    (`modem-added` / `modem-removed` / `device-state`) from the shared
    `IMonitorEmitter` (T12). The monitor has no historical replay, so the
    initial state (and every monitor restart via `onResync`) is reconciled by a
    one-shot `discoverModems()` poll.
  - A RETAINED poll runs ONLY for signal-strength / status refresh, at a reduced
    cadence (30s instead of the old 10s). It never re-lists / re-registers and
    never resets gsm connections.
  - `resetGsmConnections()` is wired exclusively through the T11
    `onGsmConnectionsReset` hook and fires ONLY on modem add/remove (and on
    config change, handled in modems.ts) — never on a status poll.
  - Re-entrancy is serialized via `withModemUpdateLock` (T13); transient `mmcli`
    failures are retried via `retryWithBackoff` (T7).
  - On removal we simply broadcast the cleaned-up state — no hot-plug recovery.

  The `modems` broadcast shape is unchanged: it is still produced by
  `broadcastModems` (modem-status.ts), keyed off the legacy `modemsState`
  record (modems-state.ts). The T11 cache (`modems-state-cache.ts`) sits on top
  as the diff engine that decides WHEN to broadcast and WHEN to reset gsm.

  The "describe a single modem" concern — registration, status building, NM
  connection profile resolution and the bounded `mmcli` retry wrappers — lives
  in the sibling `modem-registration.ts`. This file owns only the presence loop:
  the monitor wiring, the reconcile/snapshot/broadcast glue and the lifecycle.
*/

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnect,
	nmConnGetFields,
} from "../network/network-manager.ts";

import { resetGsmConnections } from "./gsm-connections.ts";
import { type ModemId } from "./mmcli.ts";
import {
	type ModemId,
	type ModemInfo,
	mmConvertAccessTech,
	mmConvertNetworkType,
	mmConvertNetworkTypes,
	mmGetModem,
	mmGetSim,
	mmList,
	parseMmcliModel,
	type SimInfo,
} from "./mmcli.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, getModemIds, removeModem } from "./modems-state.ts";
import {
	type ModemDiffEntry,
	onGsmConnectionsReset,
	onModemsChange,
	setModemsState,
	triggerGsmConnectionsReset,
} from "./state/modems-state-cache.ts";

// Retained status poll cadence. Reduced from the old 10s self-recursive loop:
// signal/status only, no presence detection, no gsm reset.
/** Interval (ms) for retained modem status poll (signal/status refresh only). */
const STATUS_POLL_INTERVAL_MS = 30_000;

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
		"gsm.apn": config.apn || "", // Empty string fallback; Bun runtime limitation with empty CLI args
		"gsm.username": config.username || "", // Empty string fallback; Bun runtime limitation with empty CLI args
		"gsm.password": config.password || "", // Empty string fallback; Bun runtime limitation with empty CLI args
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
		ifname: "", // Can be empty for GSM connections - matches by device-id and sim-id
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

	// Bridge the already-fetched flat `-K` shape into the nested form
	// parseMmcliModel expects (no second mmcli call). Missing fields stay undefined.
	const { model, manufacturer } = parseMmcliModel({
		modem: {
			generic: {
				model: modemInfo["modem.generic.model"],
				manufacturer: (modemInfo as Record<string, unknown>)[
					"modem.generic.manufacturer"
				],
			},
		},
	});

	const modem: Modem = {
		ifname: ifname,
		name: hwName,
		sim_network: simNetwork,
		model,
		manufacturer,
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

	// Mock must send FULL state: the frontend wholesale-replaces modemsState per
	// `status` message, so a status-only partial would clobber the dialog's
	// network_type.supported. Real hardware keeps the partial optimization.
	broadcastModems(shouldUseMocks() ? undefined : newModems);

	setTimeout(updateModems, modemUpdateInterval);
}
