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

import { logger } from "../../helpers/logger.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import {
	recordGsmAutoconfigProbe,
	resolveGsmAutoconfigSupport,
} from "./gsm-autoconfig.ts";

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

const NM_STATE_ACTIVATED = "activated";

/**
 * How strongly NetworkManager is currently using a profile.
 *
 * `nmcli connection show`'s STATE column is EMPTY for a profile that is not
 * attached to a device, so any non-empty value means NM has this one in hand
 * right now. That middle rank is load-bearing rather than defensive: a modem
 * that is registering, roaming-blocked, or being rejected by the network sits
 * on `activating` indefinitely — board-measured on a Quectel RM530N-GL stuck in
 * `searching` / `packet service state: detached` — and an `activated`-only test
 * falls straight through to the tie-break and picks a profile NM is not using,
 * which is the exact defect this ranking exists to prevent.
 */
function nmUsageRank(state: string): number {
	if (state === NM_STATE_ACTIVATED) return 2;
	return state.trim() === "" ? 0 : 1;
}

/**
 * Which of two profiles claiming the SAME (device, SIM) pair wins.
 *
 * A board can carry several — this bench had THIRTEEN for one SIM (see
 * `modem-registration.ts`) — and the losing choice is not cosmetic: whichever
 * profile wins is the one every later APN/roaming/credentials write is applied
 * to, so picking one NetworkManager is not using makes the whole save a no-op
 * that still reports success.
 *
 * The profile NetworkManager is USING therefore always wins ({@link nmUsageRank}):
 * it is the one carrying the device's data right now, and it is the only choice
 * that can be shown to be right rather than merely plausible. With no candidate
 * in use at all the tie is broken on the lowest uuid — arbitrary, but STABLE,
 * where nmcli's listing order is not, so two reads of an unchanged system
 * cannot disagree.
 */
export function preferGsmConnection(
	current: GsmConnection,
	candidate: GsmConnection,
): GsmConnection {
	const currentRank = nmUsageRank(current.state);
	const candidateRank = nmUsageRank(candidate.state);
	if (currentRank !== candidateRank) {
		return candidateRank > currentRank ? candidate : current;
	}
	return candidate.uuid < current.uuid ? candidate : current;
}

async function readGsmConnections() {
	const byDevice: Record<string, Record<string, GsmConnection>> = {};
	const byOperator: Record<string, GsmConnection> = {};
	const byUuid: Record<string, GsmConnection> = {};

	const conns = (await nmConnsGet("uuid,type,state")) as Array<string>;
	// The probe runs at most ONCE per read, against the first gsm profile we
	// meet: this loop is already enumerating them, and asking every profile the
	// same question would cost one extra nmcli spawn per profile on a board that
	// can legitimately carry a dozen.
	let probed = false;
	for (const c of conns) {
		const [uuid, type, state] = nmcliParseSep(c) as [string, string, string];

		if (type !== "gsm") continue;

		if (!probed) {
			probed = true;
			// A read of a property NetworkManager does not know FAILS, so a value
			// here is positive evidence that this build supports it — never a
			// version guess, and never an inference from the value itself ("no" is
			// a perfectly good answer from a supporting NM).
			const probe = await nmConnGetFields(uuid, ["gsm.auto-config"] as const);
			recordGsmAutoconfigProbe(probe !== undefined && probe[0] !== undefined);
		}

		const withAutoconfig = resolveGsmAutoconfigSupport();
		const connInfo = await nmConnGetFields(
			uuid,
			withAutoconfig
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
			...(withAutoconfig ? { autoconfig: connInfo[8] === "yes" } : {}),
		};

		byUuid[uuid] = conn;

		if (conn.deviceId && conn.simId) {
			const forDevice = byDevice[conn.deviceId] ?? {};
			const existing = forDevice[conn.simId];
			forDevice[conn.simId] =
				existing === undefined ? conn : preferGsmConnection(existing, conn);
			byDevice[conn.deviceId] = forDevice;
		}

		if (conn.operatorId) {
			const existing = byOperator[conn.operatorId];
			byOperator[conn.operatorId] =
				existing === undefined ? conn : preferGsmConnection(existing, conn);
		}
	}

	// Duplicates are not fatal — the selection above is deterministic and prefers
	// the live profile — but they ARE the visible symptom of a defect that used
	// to create one per registration, so say so rather than letting a board
	// silently accumulate them.
	for (const [deviceId, bySim] of Object.entries(byDevice)) {
		for (const simId of Object.keys(bySim)) {
			const duplicates = Object.values(byUuid).filter(
				(c) => c.deviceId === deviceId && c.simId === simId,
			);
			if (duplicates.length > 1) {
				logger.warn(
					`${duplicates.length} NetworkManager gsm profiles share one device+SIM; using ${bySim[simId]?.uuid}`,
					{ module: "modems", deviceId },
				);
			}
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
