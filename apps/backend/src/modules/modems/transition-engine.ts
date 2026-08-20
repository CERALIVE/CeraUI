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

/**
 * Building modem-stack's certified `UsbModeTransition` as this device's REAL
 * mutation engine.
 *
 * The transaction itself is not reimplemented here and must not be: its ordering
 * (NM-quiesce → inhibit → AT → port-drop → uninhibit → same-physical-UID
 * re-enumeration → POSTCONDITION → reactivate) is the certified contract, and the
 * postcondition — descriptors AND observed mode equal to the catalog target — is
 * the only proof of success it accepts. What this module supplies is the five
 * ports that contract leaves abstract, plus the interlock bridge.
 *
 * THE INTERLOCK BRIDGE IS THE POINT OF CONTACT. `TransitionInterlock` is
 * bidirectional by design: `canDisrupt` asks the streaming side "may I disrupt
 * now", and `hold` marks a transition active so a stream start is refused for its
 * duration. Both directions map onto CeraUI's existing lifecycle interlock rather
 * than onto a second guard — which is exactly why the engine can be wired without
 * inventing a parallel lease.
 *
 * A PORT THAT CANNOT BE RESOLVED YIELDS NO ENGINE. `createTransitionEngine`
 * answers `undefined` when the device has no AT control port, and the caller
 * reports the typed `engine_unavailable`. Fabricating a transition on a device
 * whose composition cannot be commanded is the one outcome worse than refusing.
 */

import {
	type AtCommandSender,
	createUsbEnumerator,
	ModemActor,
	NmcliNmPort,
	SpawnNmcliRunner,
	type TransitionInterlock,
	type UsbDeviceSnapshot,
	UsbModeTransition,
} from "@ceralive/modem-control";

import { logger } from "../../helpers/logger.ts";
import { isModemMutationHeld } from "../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../streaming/streaming.ts";

import {
	createAtSender,
	createInhibitPort,
	type InhibitPort,
} from "./transition-ports.ts";

const AT_PORT_RE = /^([\w./-]+)\s*\(at\)$/i;

/** The AT control port out of ModemManager's own `modem.generic.ports` list. */
export function findAtPort(ports: ReadonlyArray<string>): string | undefined {
	for (const entry of ports) {
		const match = AT_PORT_RE.exec(entry.trim());
		if (match?.[1] !== undefined) return match[1];
	}
	return undefined;
}

/**
 * Bridge modem-stack's transition interlock onto CeraUI's lifecycle interlock.
 *
 * `hold` is a NO-OP release rather than a second acquisition: the caller already
 * holds this device's mutation lease for the whole transaction, and taking a
 * nested one would deadlock against itself. What `canDisrupt` adds is the
 * in-actor TOCTOU re-check — a stream that was admitted while the request queued
 * closes the gate before anything disruptive runs.
 */
export function createInterlockBridge(
	stableKey: string,
	deps: { isStreaming(): boolean; holdsLease(key: string): boolean } = {
		isStreaming: getIsStreaming,
		holdsLease: isModemMutationHeld,
	},
): TransitionInterlock {
	return {
		canDisrupt() {
			if (deps.isStreaming()) {
				return Promise.resolve({
					allow: false as const,
					reason: "a stream is live",
				});
			}
			if (!deps.holdsLease(stableKey)) {
				return Promise.resolve({
					allow: false as const,
					reason: "the mutation lease is not held",
				});
			}
			return Promise.resolve({ allow: true as const });
		},
		hold() {
			return Promise.resolve({ release: () => Promise.resolve() });
		},
	};
}

export interface TransitionEngineDeps {
	readonly actor: ModemActor;
	readonly nm: NmcliNmPort;
	readonly inhibitPort: InhibitPort;
	createAtSender(portPath: string): AtCommandSender;
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
}

// ONE actor per process, keyed on the stable key inside — two transitions on the
// same modem must serialise, and two on different modems must not.
const processActor = new ModemActor();

export function defaultTransitionEngineDeps(): TransitionEngineDeps {
	return {
		actor: processActor,
		nm: new NmcliNmPort({ runner: new SpawnNmcliRunner() }),
		inhibitPort: createInhibitPort(),
		createAtSender: (portPath) => createAtSender(portPath),
		enumerate: () => createUsbEnumerator().enumerate(),
	};
}

export interface TransitionEngineRequest {
	readonly stableKey: string;
	readonly ports: ReadonlyArray<string>;
}

export function createTransitionEngine(
	request: TransitionEngineRequest,
	deps: TransitionEngineDeps = defaultTransitionEngineDeps(),
): UsbModeTransition | undefined {
	const atPort = findAtPort(request.ports);
	if (atPort === undefined) {
		logger.warn("no AT control port on this modem; no transition engine", {
			module: "modems",
			stableKey: request.stableKey,
		});
		return undefined;
	}

	return new UsbModeTransition({
		actor: deps.actor,
		nm: deps.nm,
		modemManager: deps.inhibitPort,
		atSender: deps.createAtSender(atPort),
		enumerate: deps.enumerate,
		interlock: createInterlockBridge(request.stableKey),
	});
}
