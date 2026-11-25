import type { RadioHealth } from "@ceraui/rpc/schemas";
import {
	commitRadioRoster,
	radioForModem,
	radioNeedsReset,
} from "./radio-health-runtime.ts";
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

import { invariant } from "../../helpers/invariant.ts";
import { logger } from "../../helpers/logger.ts";

import { broadcastMsg } from "../ui/websocket-server.ts";

import { resolveGsmAutoconfigSupport } from "./gsm-autoconfig.ts";
import type { ModemId } from "./mmcli.ts";
import { buildProjectedModemsMessage } from "./modem-wire-producer.ts";
import {
	type AvailableNetwork,
	getAvailableNetworksForModem,
	getModem,
	getModemIds,
	type Modem,
	type ModemConfig,
	type SimLock,
} from "./modems-state.ts";
import { evaluateRoamingAdvisoriesForWire } from "./roaming-advisory.ts";
import { claimsNoSim, type SimPresence } from "./sim-presence.ts";

type ModemsResponseModemStatus = {
	connection: string;
	network?: string;
	network_type: string;
	signal: number;
	roaming: boolean;
};

export type ModemsResponseModemBase = {
	radio_health?: RadioHealth | undefined;
	status?: ModemsResponseModemStatus;
};

export type ModemsResponseModemFull = ModemsResponseModemBase & {
	ifname: string;
	name: string;
	model?: string;
	manufacturer?: string;
	network_type: {
		supported: Array<string>;
		active: string | null;
	};
	config?: Pick<
		ModemConfig,
		"apn" | "username" | "password" | "roaming" | "network" | "autoconfig"
	> & { autoconfig_supported: boolean };
	no_sim?: true;
	sim_presence?: SimPresence;
	sim_lock?: SimLock;
	available_networks?: Record<string, AvailableNetwork>;
	network_scan?: Modem["network_scan"];
};

export type ModemsResponseMessageEntry =
	| ModemsResponseModemBase
	| ModemsResponseModemFull;

type ModemsResponseMessage = Record<string, ModemsResponseMessageEntry>;

let committedModemsWireMessage: ModemsResponseMessage = {};

function buildModemMessage(
	modem: Modem,
	modemsFullState: Record<number, true> | undefined,
	modemId: ModemId,
) {
	invariant(modem.status !== undefined, "Modem status is missing");

	const status: ModemsResponseModemStatus = {
		connection: modem.status.connection,
		...(modem.status.network !== undefined
			? { network: modem.status.network }
			: {}),
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
			...(modem.model !== undefined ? { model: modem.model } : {}),
			...(modem.manufacturer !== undefined
				? { manufacturer: modem.manufacturer }
				: {}),
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
				autoconfig: resolveGsmAutoconfigSupport() && modem.config.autoconfig,
				autoconfig_supported: resolveGsmAutoconfigSupport(),
			};
		} else if (claimsNoSim(modem.sim_presence)) {
			// An NM profile is provisioned only after a SIM has been read AND a
			// connection created for it, so its absence is NOT evidence of a
			// missing card — see `sim-presence.ts` for the board measurement.
			fullState.no_sim = true;
		}
		// The pre-collapse reading beside the fold above. State ABSENCE here means
		// the read never answered, so it is `unknown` — never omitted (which the
		// merging consumer would read as the previous value) and never "present".
		fullState.sim_presence = modem.sim_presence ?? "unknown";
		if (modem.sim_lock) {
			fullState.sim_lock = modem.sim_lock;
		}
		fullState.available_networks = getAvailableNetworksForModem(modem);
		if (modem.network_scan !== undefined) {
			fullState.network_scan = modem.network_scan;
		}

		Object.assign(entry, fullState);
	}
	return entry;
}

/**
 * The PRE-PHASE-B builder: mmcli modems, legacy fields only. NOT what reaches
 * the wire any more ({@link buildModemsWireMessage} is), and deliberately kept:
 * it is the independent implementation `modem-wire-projection.test.ts` asserts
 * the projection byte-matches — rewrite it in terms of the projection and that
 * assertion compares the projector to itself — and it is the wire builder's
 * fail-safe fallback.
 */
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

/**
 * What actually reaches every `modems` consumer — broadcast, post-login push,
 * and both pull procedures. The Phase-B projection: every legacy field
 * byte-identical, plus `stable_key` on an anchorable mmcli row and a
 * `router-ethernet` row per claimed netns dongle.
 *
 * FAIL-SAFE — a throwing projection falls back to the legacy builder rather
 * than blanking the list: the additive fields are enrichment, the legacy ones
 * are how an operator sees their modems at all.
 */
export function buildModemsWireMessage(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	const { message, projected } = buildModemsWireRows(modemsFullState);
	if (projected) attachRadioHealth(message, modemsFullState);
	return message;
}

/** The wire rows without radio enrichment, and whether the projection served them. */
function buildModemsWireRows(
	modemsFullState: Record<number, true> | undefined,
): { message: ModemsResponseMessage; projected: boolean } {
	try {
		return {
			message: buildProjectedModemsMessage(modemsFullState),
			projected: true,
		};
	} catch (error) {
		logger.warn("modem wire projection failed; serving the legacy message", {
			error,
		});
		return { message: buildModemsMessage(modemsFullState), projected: false };
	}
}

/** Each full row gets the cached radio record of its committed identity. */
function attachRadioHealth(
	message: ModemsResponseMessage,
	modemsFullState: Record<number, true> | undefined,
): void {
	for (const [id, row] of Object.entries(message)) {
		if (modemsFullState === undefined || modemsFullState[Number(id)] === true)
			row.radio_health = radioForModem(id, row as never);
	}
}

/** Return the last complete modem message published by a settled update. */
export function getCommittedModemsWireMessage(): ModemsResponseMessage {
	return committedModemsWireMessage;
}

export function broadcastModems(
	modemsFullState: Record<number, true> | undefined = undefined,
) {
	const { message: complete, projected } = buildModemsWireRows(undefined);
	committedModemsWireMessage = complete;
	// The radio sampler's only source: identity, registration and baselines
	// follow this commit, never live state that has not been committed. Radio
	// records are attached only after it, so no row carries a reading of a
	// neighbour this commit replaced or removed.
	const change = commitRadioRoster(complete);
	if (projected) attachRadioHealth(complete, undefined);
	// A modem whose device or SIM changed goes out as a full descriptor: a
	// status-only row would leave subscribers on the previous ICCID.
	let fullState = modemsFullState;
	if (fullState !== undefined && change.identity.length > 0) {
		fullState = { ...fullState };
		for (const id of change.identity) fullState[Number(id)] = true;
	}
	const modems =
		fullState === undefined ? complete : buildModemsWireMessage(fullState);
	// A partial (status-only) frame still carries the radio reset when the
	// committed modem or SIM is no longer the one the cached record belongs to,
	// a modem's record when its committed registration changed, and every row's
	// record when a commit changed the roster, since each names the others.
	for (const [id, row] of Object.entries(modems)) {
		const committed = complete[id];
		if (
			committed &&
			!("radio_health" in row) &&
			(change.roster ||
				change.registration.includes(id) ||
				radioNeedsReset(id, committed))
		)
			(row as { radio_health?: RadioHealth }).radio_health = radioForModem(
				id,
				committed as never,
			);
	}
	broadcastMsg("status", { modems });

	// The roaming advisory reconciles AFTER the payload is on the wire, and is
	// fenced: it is informational, so a failure in it must cost an operator a
	// badge — never the modem list itself. It reads the complete message this
	// broadcast committed, which carries every row the frame does: absence from
	// it is the retraction evidence for a device that disappeared, and its rows
	// keep the stable key and name a status-only row omits, so a partial frame
	// never moves a standing advisory to another slot. See `roaming-advisory.ts`.
	try {
		evaluateRoamingAdvisoriesForWire(complete);
	} catch (error) {
		logger.warn("roaming advisory evaluation failed", { error });
	}
}

/**
 * Publish radio enrichment for the committed roster only. Diagnostic sampling
 * runs outside the modem update lock, so live state may hold a staged change or
 * removal; this never reads it. Each committed row gets its cached radio record
 * beside the status it was committed with, so no staged status or control
 * field can be replayed.
 */
export function broadcastRadioHealth(): void {
	const modems: Record<
		string,
		Pick<ModemsResponseModemBase, "status"> & {
			radio_health: RadioHealth;
		}
	> = {};
	for (const [id, committed] of Object.entries(committedModemsWireMessage)) {
		if (!("ifname" in committed) || typeof committed.ifname !== "string")
			continue;
		const radio_health = radioForModem(id, committed);
		committedModemsWireMessage[id] = { ...committed, radio_health };
		modems[id] =
			committed.status === undefined
				? { radio_health }
				: { status: committed.status, radio_health };
	}
	broadcastMsg("status", { modems });
}
