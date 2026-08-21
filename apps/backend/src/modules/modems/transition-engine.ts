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
	type UsbModeTransitionRequest,
} from "@ceralive/modem-control";

import { logger } from "../../helpers/logger.ts";
import { isModemMutationHeld } from "../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import { resolveModemNmDeviceForConnection } from "./modem-nm-device.ts";
import {
	createAtSender,
	createInhibitPort,
	defaultInhibitPortDeps,
	type InhibitPort,
	waitForAtPortReady,
} from "./transition-ports.ts";
import type { UsbModeTransitionEngine } from "./usb-mode-contract.ts";

const AT_PORT_RE = /^([\w./-]+)\s*\(at\)$/i;
const REENUMERATION_TIMEOUT_MS = 60_000;
const REENUMERATION_POLL_MS = 250;

/**
 * The AT control port out of ModemManager's own `modem.generic.ports` list, as
 * an OPENABLE PATH.
 *
 * MM names a port by its bare kernel name (`ttyUSB7 (at)`), which is not a path
 * — board-measured, the transition died at
 * `ENOENT: no such file or directory, open 'ttyUSB7'` after the lease, the
 * journal and the inhibit had all been taken. An entry that already carries a
 * path is left alone, so a future MM that reports one is unaffected.
 */
export function findAtPort(ports: ReadonlyArray<string>): string | undefined {
	for (const entry of ports) {
		const match = AT_PORT_RE.exec(entry.trim());
		const name = match?.[1];
		if (name === undefined) continue;
		return name.includes("/") ? name : `/dev/${name}`;
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
	createInhibitPort(atPort: string): InhibitPort;
	createAtSender(portPath: string): AtCommandSender;
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
	resolveReenumeratedIfname(connectionId: string): Promise<string | undefined>;
	readonly reenumerationTimeoutMs: number;
	readonly pollIntervalMs: number;
}

// ONE actor per process, keyed on the stable key inside — two transitions on the
// same modem must serialise, and two on different modems must not.
const processActor = new ModemActor();

export function defaultTransitionEngineDeps(): TransitionEngineDeps {
	return {
		actor: processActor,
		nm: new NmcliNmPort({ runner: new SpawnNmcliRunner() }),
		// The AT port is bound here so the inhibition can wait for POSITIVE
		// evidence that ModemManager released that exact tty.
		createInhibitPort: (atPort) =>
			createInhibitPort({
				...defaultInhibitPortDeps,
				confirmPortFree: () => waitForAtPortReady(atPort),
			}),
		createAtSender: (portPath) => createAtSender(portPath),
		enumerate: () => createUsbEnumerator().enumerate(),
		resolveReenumeratedIfname: resolveModemNmDeviceForConnection,
		reenumerationTimeoutMs: REENUMERATION_TIMEOUT_MS,
		pollIntervalMs: REENUMERATION_POLL_MS,
	};
}

export interface TransitionEngineRequest {
	readonly stableKey: string;
	readonly ports: ReadonlyArray<string>;
}

export function createTransitionEngine(
	request: TransitionEngineRequest,
	deps: TransitionEngineDeps = defaultTransitionEngineDeps(),
): UsbModeTransitionEngine | undefined {
	const atPort = findAtPort(request.ports);
	if (atPort === undefined) {
		logger.warn("no AT control port on this modem; no transition engine", {
			module: "modems",
			stableKey: request.stableKey,
		});
		return undefined;
	}
	const modemManager = deps.createInhibitPort(atPort);
	const atSender = deps.createAtSender(atPort);

	return {
		async execute(transitionRequest: UsbModeTransitionRequest) {
			let observedPortDrop = false;
			const enumerate = async (): Promise<readonly UsbDeviceSnapshot[]> => {
				const devices = await deps.enumerate();
				const target = devices.find(
					(device) =>
						device.physicalUid === transitionRequest.cachedPhysicalUid,
				);
				if (target === undefined) {
					observedPortDrop = true;
					return devices;
				}
				if (!observedPortDrop) return devices;

				const deadline = Date.now() + deps.reenumerationTimeoutMs;
				while (Date.now() < deadline) {
					const ifname = await deps.resolveReenumeratedIfname(
						String(transitionRequest.connectionId),
					);
					if (ifname !== undefined) {
						return devices.map((device) =>
							device.physicalUid === transitionRequest.cachedPhysicalUid
								? { ...device, ifname }
								: device,
						);
					}
					await new Promise((resolve) =>
						setTimeout(resolve, deps.pollIntervalMs),
					);
				}
				throw new Error(
					`post-switch NetworkManager interface did not resolve within ${deps.reenumerationTimeoutMs}ms`,
				);
			};

			return new UsbModeTransition({
				actor: deps.actor,
				nm: deps.nm,
				modemManager,
				atSender,
				enumerate,
				interlock: createInterlockBridge(request.stableKey),
				reenumerationTimeoutMs: deps.reenumerationTimeoutMs,
				pollIntervalMs: deps.pollIntervalMs,
			}).execute(transitionRequest);
		},
	};
}
