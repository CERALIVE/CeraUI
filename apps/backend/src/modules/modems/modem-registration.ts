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
  Modem registration & status building — the "describe a single modem" concern,
  split out of modem-update-loop.ts.

  This module owns everything about turning raw `mmcli` output into a `Modem`
  record: resolving/creating the NetworkManager gsm connection profile, sanitizing
  config for NM, building the `ModemStatus` snapshot, and the bounded-retry
  wrappers around the flaky `mmcli` list / get calls. It is consumed by the
  event-driven presence loop (modem-update-loop.ts) which decides WHEN to
  register / refresh; this module decides HOW.

  Pure data-flow into the legacy `modemsState` record (modems-state.ts): the
  loop publishes snapshots and broadcasts — none of that lives here.
*/

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnect,
	nmConnGetFields,
} from "../network/network-manager.ts";
import { setup } from "../setup.ts";

import { getGsmConnections } from "./gsm-connections.ts";
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
	parseModemUnlockInfo,
	type SimInfo,
} from "./mmcli.ts";
import {
	getModem,
	type Modem,
	type ModemConfig,
	type SimLock,
	setModem,
} from "./modems-state.ts";

export type ModemStatus = {
	connection: string;
	network?: string;
	network_type: string; // e.g. '3g4g'
	signal: number; // 0-100
	roaming: boolean;
};

// Bounded retry for transient mmcli failures (mock mode never retries — the
// mock provider always returns data on the first call).
/** Retry configuration for transient mmcli failures. */
const MMCLI_RETRY = {
	/** Maximum number of retry attempts for mmcli commands. */
	maxAttempts: 3,
	/** Initial backoff delay (ms) for mmcli retry. */
	baseDelayMs: 200,
	/** Maximum backoff delay (ms) for mmcli retry. */
	maxDelayMs: 2000,
} as const;

async function getModemConfig(
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
			void nmConnect(modem.config.conn);
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
	// mmcliParseSep emits every `-K` field as a string ("53") despite the typed
	// `number`, so coerce here to honor the `z.number()` contract — otherwise
	// `modemSignal()`'s `Number.isFinite` gate drops every modem's signal.
	const signal = Number(modemInfo["modem.generic.signal-quality.value"]);
	const roaming = modemInfo["modem.3gpp.registration-state"] === "roaming";
	const connection = modem.is_scanning
		? "scanning"
		: modemInfo["modem.generic.state"];

	return {
		connection,
		...(network !== undefined ? { network } : {}),
		network_type,
		signal,
		roaming,
	};
}

function buildSimLock(modemInfo: Readonly<ModemInfo>): SimLock | undefined {
	const info = parseModemUnlockInfo(
		modemInfo as unknown as Record<string, string | Array<string>>,
	);
	if (info.required === "none") {
		return undefined;
	}
	const remainingAttempts = info.retries[info.required];
	return remainingAttempts === undefined
		? { required: info.required }
		: { required: info.required, remainingAttempts };
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

/**
 * Fetch modem info with a bounded backoff retry for transient mmcli failures.
 * `mmGetModem` swallows its own errors and returns `undefined`; we treat that
 * as a retryable failure by throwing inside the retry wrapper. Returns
 * `undefined` only after all attempts are exhausted.
 */
async function mmGetModemWithRetry(
	id: ModemId,
): Promise<ModemInfo | undefined> {
	return pollWithBackoff(() => mmGetModem(id), {
		...MMCLI_RETRY,
		emptyResultError: () => new Error(`mmGetModem(${id}) returned no info`),
		onExhausted: (err) =>
			logger.error(
				`Failed to get modem info for modem ${id} after retries: ${String(err)}`,
			),
	});
}

/** List modem ids with a bounded backoff retry for transient mmcli failures. */
export async function mmListWithRetry(): Promise<Array<ModemId> | undefined> {
	return pollWithBackoff(() => mmList(), {
		...MMCLI_RETRY,
		emptyResultError: () => new Error("mmList returned no result"),
		onExhausted: (err) =>
			logger.error(`Failed to list modems after retries: ${String(err)}`),
	});
}

async function registerModem(id: number) {
	if (getModem(id)) {
		throw new Error(`Trying to register existing modem id ${id}`);
	}

	// Get all the required info for the modem
	const modemInfo = await mmGetModemWithRetry(id);
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
				config = await getModemConfig(modemInfo, simInfo);

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
		...(model !== undefined ? { model } : {}),
		...(manufacturer !== undefined ? { manufacturer } : {}),
		network_type: {
			supported: networkTypes,
			active: networkType?.label ?? null,
		},
		...(config !== undefined ? { config } : {}),
	};

	modem.status = buildModemStatus(modemInfo, modem);
	const simLock = buildSimLock(modemInfo);
	if (simLock !== undefined) modem.sim_lock = simLock;

	setModem(id, modem);
}

/** Register a modem, swallowing failures so a single bad modem can't break the batch. */
export async function registerModemSafe(id: ModemId): Promise<void> {
	try {
		logger.debug("Trying to register modem", id);
		await registerModem(id);
		logger.debug(
			"Registered modem",
			JSON.stringify(getModem(id), undefined, 2),
		);
	} catch (err) {
		logger.error(`Failed to register modem ${id}: ${String(err)}`);
	}
}

/**
 * Refresh a single already-registered modem's status (signal / connection /
 * registration / network). Produces a NEW `Modem` object (immutable replace)
 * so the T11 cache can detect the change by value — mutating in place would
 * make the cached previous snapshot point at the same (now-updated) object and
 * the diff would be empty.
 */
export async function refreshModemStatus(id: ModemId): Promise<void> {
	const modem = getModem(id);
	if (!modem) {
		return;
	}

	const modemInfo = await mmGetModemWithRetry(id);
	if (!modemInfo) {
		return;
	}

	const status = buildModemStatus(modemInfo, modem);
	const simLock = buildSimLock(modemInfo);
	const { removed: _removed, ...modemRest } = modem;
	const updated: Modem = {
		...modemRest,
		status,
		...(simLock !== undefined ? { sim_lock: simLock } : {}),
	};
	setModem(id, updated);

	await connectModemIfNeededAndPossible(updated, id);
}
