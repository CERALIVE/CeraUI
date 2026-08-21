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

import type { ModemRegistrationRejection } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnect,
	nmConnGetFields,
} from "../network/network-manager.ts";
import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import { getGsmConnections, resetGsmConnections } from "./gsm-connections.ts";
import { reconcileDuplicateGsmProfiles } from "./gsm-duplicate-reconcile.ts";
import {
	type ModemId,
	type ModemInfo,
	mmConvertAccessTech,
	mmConvertNetworkType,
	mmConvertNetworkTypes,
	mmGetModem,
	mmGetSim,
	mmList,
	type NetworkType,
	parseMmcliModel,
	parseModemUnlockInfo,
	type SimInfo,
} from "./mmcli.ts";
import { modemHardwareName } from "./modem-identity.ts";
import {
	getModem,
	type Modem,
	type ModemConfig,
	type SimLock,
	setModem,
} from "./modems-state.ts";
import { deriveSimPresence } from "./sim-presence.ts";

export type ModemStatus = {
	connection: string;
	network?: string;
	network_type: string; // e.g. '3g4g'
	signal: number; // 0-100
	roaming: boolean;
	// Deliberately NOT part of the wire `status` block — `buildModemMessage` and
	// `fromMmcliModem` both copy that block field-by-field, so these ride here
	// only to inherit `buildModemStatus`'s wholesale rebuild: a modem that
	// registers stops reporting a rejection and the stale reason cannot survive.
	packet_service_state?: string;
	registration_rejection?: ModemRegistrationRejection;
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
	const packetServiceState = modemInfo["modem.3gpp.packet-service-state"];
	const rejection = buildRegistrationRejection(modemInfo);

	return {
		connection,
		...(network !== undefined ? { network } : {}),
		network_type,
		signal,
		roaming,
		...(packetServiceState !== undefined
			? { packet_service_state: packetServiceState }
			: {}),
		...(rejection !== undefined ? { registration_rejection: rejection } : {}),
	};
}

/**
 * The network's own stated reason for refusing registration.
 *
 * `network-rejection-error` is the anchor: mmcli emits the operator-id /
 * access-technology fields alongside a rejection, and without the error token
 * they describe nothing an operator could act on. So no error ⇒ no rejection,
 * rather than a partial object that reads as a fault where none was reported.
 */
function buildRegistrationRejection(
	modemInfo: Readonly<ModemInfo>,
): ModemRegistrationRejection | undefined {
	const error = modemInfo["modem.3gpp.network-rejection-error"];
	if (error === undefined || error.trim() === "") {
		return undefined;
	}
	const accessTechnology =
		modemInfo["modem.3gpp.network-rejection-access-technology"];
	const operatorId = modemInfo["modem.3gpp.network-rejection-operator-id"];
	const operatorName = modemInfo["modem.3gpp.network-rejection-operator-name"];
	return {
		error,
		...(accessTechnology !== undefined
			? { access_technology: accessTechnology }
			: {}),
		...(operatorId !== undefined ? { operator_id: operatorId } : {}),
		...(operatorName !== undefined ? { operator_name: operatorName } : {}),
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
	const autoConfig = resolveGsmAutoconfigSupport() && config.autoconfig;

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

/**
 * Derive the radio-mode block (`supported` + `active`) from a `-K` payload.
 *
 * `current-modes` and `supported-modes` ride EVERY `mmcli -K -m <id>` read, so
 * re-deriving them costs no extra spawn — the status refresh was simply carrying
 * DISCOVERY's answer forward for the process lifetime. Board-proven on a Quectel
 * RM530N-GL: the modem was moved to `allowed: 3g` by something other than this
 * backend and CeraUI still reported `5g4g` minutes later, past several 30 s
 * polls. Worse than a stale label — `applyModemConfig` compares the request
 * against this value to decide whether a radio write is needed at all, so saving
 * the mode the dialog was SHOWING skipped the mmcli call entirely and answered
 * `{success: true}`. The operator's save was a silent no-op.
 *
 * `undefined` means "this payload could not answer", which is a statement about
 * the READ and never about the radio — the caller keeps what it had rather than
 * blanking a modem's mode list over one unreadable poll.
 */
export function deriveNetworkTypes(
	modemInfo: ModemInfo,
): Modem["network_type"] | undefined {
	const currentRaw = modemInfo["modem.generic.current-modes"];
	const supportedRaw = modemInfo["modem.generic.supported-modes"];
	if (currentRaw === undefined && supportedRaw === undefined) {
		return undefined;
	}

	let current: ReturnType<typeof mmConvertNetworkType> | undefined;
	if (currentRaw) {
		try {
			current = mmConvertNetworkType(currentRaw);
		} catch {
			// An unparsable current-modes line leaves the ACTIVE mode unknown, and
			// "unknown" is not evidence that the previous answer became wrong.
			logger.warn(`Unparsable mmcli current-modes: ${currentRaw}`);
			return undefined;
		}
	}

	const supported = mmConvertNetworkTypes(
		Array.isArray(supportedRaw) ? supportedRaw : [],
	);

	// Make sure the current mode is on the list
	if (current && !supported[current.label]) {
		supported[current.label] = {
			allowed: current.allowed,
			preferred: current.preferred,
		};
	}

	return { supported, active: current?.label ?? null };
}

/**
 * The same `-K` payload, UNFOLDED — every `(allowed, preferred)` pair mmcli
 * reported, plus the pair the radio is on right now.
 *
 * `deriveNetworkTypes` above folds the catalog by allowed-set label and keeps one
 * `preferred` per label, which is what the coarse 3G/4G/5G selector needs and is
 * lossy for anything that ranks within an allowed set. Deriving both from the one
 * payload costs no extra spawn and keeps them incapable of disagreeing about what
 * the modem said.
 *
 * `undefined` follows the same rule as its sibling: it means the PAYLOAD could not
 * answer, so the caller keeps what it had rather than blanking a catalog over one
 * unreadable poll.
 */
export function deriveRadioModeCatalog(
	modemInfo: ModemInfo,
): Modem["radio_modes"] | undefined {
	const currentRaw = modemInfo["modem.generic.current-modes"];
	const supportedRaw = modemInfo["modem.generic.supported-modes"];
	if (currentRaw === undefined && supportedRaw === undefined) {
		return undefined;
	}

	const supported: NetworkType[] = [];
	for (const raw of Array.isArray(supportedRaw) ? supportedRaw : []) {
		try {
			const { allowed, preferred } = mmConvertNetworkType(raw);
			supported.push({ allowed, preferred });
		} catch {
			// One unparsable row is a statement about THAT row. Dropping it keeps the
			// rest of a real catalog usable; aborting would discard a modem's whole
			// 5G posture over a line nothing else needs.
			logger.warn(`Unparsable mmcli supported-mode row: ${raw}`);
		}
	}

	let current: NetworkType | undefined;
	if (currentRaw) {
		try {
			const parsed = mmConvertNetworkType(currentRaw);
			current = { allowed: parsed.allowed, preferred: parsed.preferred };
		} catch {
			return undefined;
		}
	}

	return { supported, ...(current === undefined ? {} : { current }) };
}

/**
 * The SIM's own number(s) from a fresh `-K` payload, or `undefined` when the
 * carrier published none.
 *
 * Unlike `deriveNetworkTypes`, an absent answer is NOT a statement about the
 * read: `parseModemInfo` already rejects a record with no `modem.` key at all,
 * so a successful parse that omits this one means the modem reported no MSISDN.
 * That is why the refresh REPLACES rather than retains — a SIM swap must be able
 * to clear the previous subscriber's number, not latch it on screen.
 */
export function deriveOwnNumbers(
	modemInfo: ModemInfo,
): Array<string> | undefined {
	const numbers = modemInfo["modem.generic.own-numbers"];
	return numbers !== undefined && numbers.length > 0 ? [...numbers] : undefined;
}

/**
 * Rebuild an already-registered modem from a fresh `-K` payload.
 *
 * Pure — the caller owns the fetch and the write — so the merge rule is provable
 * without an mmcli on the host. This is where the mode latch lived: the previous
 * shape spread the whole previous modem and replaced only `status`/`sim_lock`.
 */
export function mergeRefreshedModem(
	previous: Modem,
	modemInfo: ModemInfo,
): Modem {
	const status = buildModemStatus(modemInfo, previous);
	const simLock = buildSimLock(modemInfo);
	const networkType = deriveNetworkTypes(modemInfo);
	const radioModes = deriveRadioModeCatalog(modemInfo);
	const simPresence = deriveSimPresence(modemInfo);
	const ownNumbers = deriveOwnNumbers(modemInfo);
	const {
		removed: _removed,
		own_numbers: _staleOwnNumbers,
		...previousRest
	} = previous;
	return {
		...previousRest,
		status,
		// `unknown` is a statement about the READ, so the previous answer stands
		// rather than a modem's SIM silently becoming undetected on one poll.
		...(simPresence !== "unknown" ? { sim_presence: simPresence } : {}),
		...(ownNumbers !== undefined ? { own_numbers: ownNumbers } : {}),
		...(simLock !== undefined ? { sim_lock: simLock } : {}),
		...(networkType !== undefined ? { network_type: networkType } : {}),
		...(radioModes !== undefined ? { radio_modes: radioModes } : {}),
	};
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

				// `getModemConfig` ALWAYS returns a config, so an unguarded call
				// here created a brand-new NetworkManager profile on EVERY
				// registration — including the pass that had just found one — and
				// then re-pointed `config.conn` at it. Board-measured on a Rock 5B+
				// (2026-08-16): 13 gsm profiles for ONE SIM in a single day, each
				// preceded in the log by a "Found NM connection …" line, while the
				// profile NetworkManager had actually activated was the oldest. So
				// every APN save landed on a profile nothing used — a save that
				// reported success and could never take effect.
				if (config && !config.conn) {
					await addConnectionForModem(modemInfo, simInfo, config);
				} else if (config?.conn) {
					// Writing to the right profile is only half the job. Disarming the
					// clones (todo 50) narrows the race; making them CARRY THE SAME
					// ANSWER removes it, which is what todo 63 needs for roaming — the
					// operator's "roaming disabled" must survive NetworkManager
					// activating any profile at all, not just the one we selected.
					// Sanitizing a COPY: the real config must not be normalized here,
					// only the fields handed to NetworkManager.
					const enforced = sanitizeModemConfigForNetworkManager({ ...config });
					const result = await reconcileDuplicateGsmProfiles(
						modemInfo["modem.generic.device-identifier"],
						simInfo["sim.properties.iccid"],
						config.conn,
						enforced,
					);
					// A prune invalidates the profile cache this registration read from.
					if (result.pruned > 0) resetGsmConnections();
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

	const networkType = deriveNetworkTypes(modemInfo) ?? {
		supported: {},
		active: null,
	};
	const radioModes = deriveRadioModeCatalog(modemInfo);
	const simPresence = deriveSimPresence(modemInfo);
	const ownNumbers = deriveOwnNumbers(modemInfo);

	// Some firmware answers ModemManager's identity query with a bare numeral —
	// board-measured `manufacturer: 1` / `model: 0`, which rendered as the row
	// title "0 - 54863". modemHardwareName falls back to another string the SAME
	// device reported; nothing here is ever invented. See modem-identity.ts.
	const hwName = modemHardwareName({
		model: modemInfo["modem.generic.model"],
		manufacturer: modemInfo["modem.generic.manufacturer"],
		firmwareRevision: modemInfo["modem.generic.revision"],
		equipmentId: modemInfo["modem.generic.equipment-identifier"],
	});

	let simNetwork = "<NO SIM>";
	if (simInfo) {
		simNetwork = simInfo["sim.properties.operator-name"] || "Unknown";
	}

	// A locked SIM withholds its ICCID and mmcli prints `--`, which the parser
	// already reduces to an empty string — so absence and "not readable yet" are
	// the same honest answer here, and neither may reach the wire as a value.
	const iccid = simInfo?.["sim.properties.iccid"]?.trim();

	// Bridge the already-fetched flat `-K` shape into the nested form
	// parseMmcliModel expects (no second mmcli call). Missing fields stay undefined.
	const { model, manufacturer } = parseMmcliModel({
		modem: {
			generic: {
				model: modemInfo["modem.generic.model"],
				manufacturer: modemInfo["modem.generic.manufacturer"],
			},
		},
	});

	const modem: Modem = {
		ifname: ifname,
		name: hwName,
		sim_network: simNetwork,
		...(model !== undefined ? { model } : {}),
		...(manufacturer !== undefined ? { manufacturer } : {}),
		network_type: networkType,
		...(radioModes !== undefined ? { radio_modes: radioModes } : {}),
		...(simPresence !== "unknown" ? { sim_presence: simPresence } : {}),
		...(ownNumbers !== undefined ? { own_numbers: ownNumbers } : {}),
		...(iccid ? { iccid } : {}),
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

	const updated = mergeRefreshedModem(modem, modemInfo);
	setModem(id, updated);

	await connectModemIfNeededAndPossible(updated, id);
}
