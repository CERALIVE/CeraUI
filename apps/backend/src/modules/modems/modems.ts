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

import {
	decideModemReactivation,
	diffModemConnectionFields,
	type ModemConnectionHold,
	normalizeModemConnectionFields,
} from "@ceraui/rpc/schemas";
import type WebSocket from "ws";

import { logger } from "../../helpers/logger.ts";
import { extractMessage } from "../../helpers/types.ts";

import {
	type ConnectionUUID,
	nmConnGetFields,
	nmConnSetFields,
	nmDisconnect,
} from "../network/network-manager.ts";

import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import { getGsmConnections, resetGsmConnections } from "./gsm-connections.ts";
import { reconcileDuplicateGsmProfiles } from "./gsm-duplicate-reconcile.ts";
import { setGsmOperatorName } from "./gsm-operators-cache.ts";
import { mmSetNetworkTypes } from "./mmcli.ts";
import { modemNetworkScan } from "./modem-network-scan.ts";
import { sanitizeModemConfigForNetworkManager } from "./modem-registration.ts";
import { broadcastModems } from "./modem-status.ts";
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

/**
 * Make the operator's answer true on EVERY profile bound to this modem's SIM.
 *
 * Writing only the selected profile leaves the operator's choice hostage to
 * NetworkManager's own activation logic. `gsm.home-only` is the case that makes
 * this a safety defect rather than a tidiness one: it becomes the bearer's
 * allow-roaming flag at `Simple.Connect`, so a duplicate still carrying `no`
 * registers a roaming session for an operator who disabled roaming — silently,
 * with the UI still reporting the value the written profile holds.
 *
 * The identity is read from the profile itself (`byUuid`), never from `Modem`:
 * `gsm.device-id`/`gsm.sim-id` are what NetworkManager matches on, so they are
 * the only keys that name the same set of profiles NM would choose among.
 */
async function enforceModemConfigAcrossProfiles(
	connectionUuid: ConnectionUUID,
	config: ModemConfig,
): Promise<number> {
	const selected = (await getGsmConnections()).byUuid[connectionUuid];
	if (!selected?.deviceId || !selected.simId) return 0;

	const result = await reconcileDuplicateGsmProfiles(
		selected.deviceId,
		selected.simId,
		connectionUuid,
		sanitizeModemConfigForNetworkManager({ ...config }),
	);
	if (result.pruned > 0) resetGsmConnections();
	return result.duplicates;
}

/**
 * Is NetworkManager holding this profile right now?
 *
 * `nmcli --get-values GENERAL.STATE connection show <uuid>` prints the state for
 * a profile NM has attached to a device and NOTHING AT ALL for a detached one —
 * measured on the board: `activated` for the live ethernet profile, EMPTY output
 * for the idle gsm one. So a non-empty answer is positive evidence NM has the
 * profile in hand (including `activating`, where a bearer is being built from
 * the values we are about to replace), and an empty answer is positive evidence
 * it does not. A failed read proves neither, so it stays `unknown` and is
 * treated as held — see `decideModemReactivation`.
 */
async function readModemConnectionHold(
	connectionUuid: ConnectionUUID,
): Promise<ModemConnectionHold> {
	const fields = await nmConnGetFields(connectionUuid, [
		"GENERAL.STATE",
	] as const);
	if (!fields) return "unknown";
	return (fields[0] ?? "").trim() === "" ? "idle" : "held";
}

/** Injected so the reactivation DECISION is provable without an nmcli on the host. */
export type ModemApplyDeps = {
	readonly writeConnection: (
		connectionUuid: ConnectionUUID,
		config: ModemConfig,
	) => Promise<boolean>;
	readonly readConnectionHold: (
		connectionUuid: ConnectionUUID,
	) => Promise<ModemConnectionHold>;
	readonly enforceAcrossProfiles: (
		connectionUuid: ConnectionUUID,
		config: ModemConfig,
	) => Promise<number>;
	readonly disconnect: (connectionUuid: ConnectionUUID) => Promise<unknown>;
	readonly setNetworkTypes: (
		id: number,
		allowed: string,
		preferred: string,
	) => Promise<unknown>;
	readonly autoconfigSupported: () => boolean;
};

export const defaultModemApplyDeps: ModemApplyDeps = {
	writeConnection: updateModemConnection,
	readConnectionHold: readModemConnectionHold,
	enforceAcrossProfiles: enforceModemConfigAcrossProfiles,
	disconnect: nmDisconnect,
	setNetworkTypes: mmSetNetworkTypes,
	autoconfigSupported: resolveGsmAutoconfigSupport,
};

/**
 * Why a modem-config write was refused. Wire-stable tokens: the RPC returns
 * them verbatim and the dialog keys operator copy off them, so they are renamed
 * only alongside the schema and all ten locales.
 */
export type ModemConfigRefusal =
	| "device_busy"
	| "unknown_modem"
	| "unconfigured_modem"
	| "invalid_config"
	| "unsupported_network_type"
	| "unavailable_network"
	| "write_failed";

export type ModemConfigOutcome =
	| { ok: true; reconnected: boolean }
	| { ok: false; reason: ModemConfigRefusal };

/**
 * Apply a modem configuration, and SAY whether it landed.
 *
 * Every early return below used to be a silent one — the caller dispatched this
 * with `void` and answered `{success: true}` regardless — so a save the device
 * refused outright was reported to the operator as saved. That is the same
 * class of defect todo 47 found in the interface-address field, and it is why
 * this returns an outcome rather than `void`.
 */
export async function applyModemConfig(
	msg: ModemConfigMessage["config"],
	deps: ModemApplyDeps = defaultModemApplyDeps,
): Promise<ModemConfigOutcome> {
	// `!msg.device` would also reject mmcli id 0, which is a perfectly ordinary
	// modem index — the check is about a MISSING id, not a falsy one.
	if (msg.device === undefined || !Number.isFinite(msg.device)) {
		logger.info("Ignoring modem config for unknown modem (no id)");
		return { ok: false, reason: "unknown_modem" };
	}

	const modem = getModem(msg.device);
	if (!modem) {
		logger.info(`Ignoring modem config for unknown modem ${msg.device}`);
		return { ok: false, reason: "unknown_modem" };
	}

	const connUuid = modem.config?.conn;
	if (!connUuid || !modem.config) {
		logger.warn(`Ignoring modem config for unconfigured modem ${msg.device}`);
		logger.debug("Modem config", modem.config);
		return { ok: false, reason: "unconfigured_modem" };
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
		return { ok: false, reason: "invalid_config" };
	}

	// Ensure the selected network type is supported
	const networkType = modem.network_type.supported[msg.network_type];
	if (!networkType) {
		logger.error(
			`Received invalid network type ${msg.network_type} for modem ${msg.device}`,
		);
		return { ok: false, reason: "unsupported_network_type" };
	}

	// Only allow automatic network selection, the network previously saved, or a network included in the scan results
	if (
		msg.network &&
		msg.network !== "" &&
		msg.network !== modem.config.network &&
		!modem.available_networks?.[msg.network]
	) {
		logger.warn(
			`Received unavailable network ${msg.network} for modem ${msg.device}`,
		);
		return { ok: false, reason: "unavailable_network" };
	}

	// If a new network is selected, write it to the GSM operators cache
	const newNetwork =
		msg.network &&
		msg.network !== "" &&
		modem.available_networks?.[msg.network];
	if (newNetwork) {
		void setGsmOperatorName(msg.network, newNetwork.name);
	}

	// Captured BEFORE the write, because `sanitizeModemConfigForNetworkManager`
	// normalizes `modem.config` in place on its way through.
	const autoconfigSupported = deps.autoconfigSupported();
	const previousFields = normalizeModemConnectionFields(
		modem.config,
		autoconfigSupported,
	);

	// Temporary config that we'll attempt to write
	const updatedConfig: ModemConfig = {
		autoconfig: msg.autoconfig,
		apn: msg.apn,
		username: msg.username,
		password: msg.password,
		roaming: msg.roaming,
		network: msg.network,
	};
	const nextFields = normalizeModemConnectionFields(
		updatedConfig,
		autoconfigSupported,
	);
	const written = await deps.writeConnection(connUuid, updatedConfig);
	if (written) {
		// This preserves the 'conn' UUID value
		Object.assign(modem.config, updatedConfig);
		// Ahead of any reconnect below, so the profile NetworkManager brings back
		// up already agrees with the operator whichever one it picks.
		await deps.enforceAcrossProfiles(connUuid, updatedConfig);
	} else {
		logger.error(
			`Failed to update NM connection ${connUuid} for modem ${msg.device}`,
		);
		logger.debug("Failed modem config update", updatedConfig);
	}

	// Every gsm connect-time value is baked into the bearer, so a change to one
	// can only be applied by re-establishing it — but this used to run
	// UNCONDITIONALLY, so re-saving an untouched dialog, or toggling roaming and
	// putting it back, tore the bearer down for nothing. A write that failed is
	// likewise nothing to reactivate for.
	// The hold is read only once a change is established, so an untouched save
	// costs no nmcli spawn either.
	const changed =
		written && diffModemConnectionFields(previousFields, nextFields).length > 0;
	const decision = changed
		? decideModemReactivation({
				previous: previousFields,
				next: nextFields,
				hold: await deps.readConnectionHold(connUuid),
			})
		: ({ reactivate: false, reason: "unchanged" } as const);

	modem.inhibit = true;
	if (decision.reactivate) {
		logger.info(
			`Reconnecting modem ${msg.device} to apply ${decision.changed.join(", ")}`,
		);
		await deps.disconnect(connUuid);
	}

	// A refused radio-mode write is a FAILED save, not a footnote. This used to
	// be swallowed on the theory that the configure-echo reported it — but the
	// echo parrots the REQUEST, so a mode the modem rejected reached the operator
	// as "Saved" with the requested value locked into the dialog.
	let networkTypeWritten = true;
	if (msg.network_type !== modem.network_type.active) {
		const result = await deps.setNetworkTypes(
			msg.device,
			networkType.allowed,
			networkType.preferred,
		);
		if (result) {
			modem.network_type.active = msg.network_type;
		} else {
			networkTypeWritten = false;
			logger.error(
				`Failed to set network type ${msg.network_type} on modem ${msg.device}`,
			);
		}
	}
	delete modem.inhibit;

	// Send the updated settings to the clients
	broadcastModems({ [msg.device]: true });

	if (!written || !networkTypeWritten) {
		return { ok: false, reason: "write_failed" };
	}
	return { ok: true, reconnected: decision.reactivate };
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
				void applyModemConfig(
					extractMessage<ModemConfigMessage, typeof type>(msg, type),
				);
				break;
			case "scan":
				void handleModemScan(
					conn,
					extractMessage<ModemScanMessage, typeof type>(msg, type),
				);
				break;
		}
	}
}
