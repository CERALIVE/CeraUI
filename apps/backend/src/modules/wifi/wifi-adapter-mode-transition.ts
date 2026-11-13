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
  The six per-adapter mode transitions, and the boot reconciliation of the
  operator's persisted choice.

  One adapter lock owns the complete transition, including persistence and undo.
  The internal hotspot delegates run under that owner without reacquiring the
  non-reentrant lock or recording the intermediate stop as a user choice.

  EVERY EXIT PATH ENDS IN A TERMINAL FRAME, and there is exactly one publisher
  per path. A refusal decided here publishes here. A transition that reaches
  NetworkManager publishes through a CHAINED hotspot publisher, so the mode's
  terminal frame settles when the AP's own bounded confirmation settles rather
  than when the RPC returns — `accepted: true` is a promise of a later frame,
  never a claim that the radio has reached the mode.
*/

import type {
	SetWifiAdapterModeOutput,
	WifiAdapterMode,
	WifiAdapterModeError,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	isWifiAdapterModeAvailable,
	observedWifiAdapterMode,
	persistWifiAdapterMode,
	recordWifiAdapterModeIntent,
	resolveWifiAdapterModeIntentKey,
	restoreWifiAdapterMode,
	wifiAdapterModeCapability,
	wifiAdapterModeOptions,
} from "./wifi-adapter-mode.ts";
import {
	type AdapterModeOutcomePublisher,
	publishAdapterModeOutcome,
} from "./wifi-adapter-mode-outcome.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import { captureWifiFrameIncarnation } from "./wifi-frame-binding.ts";
import { withWifiFrameIncarnation } from "./wifi-frame-incarnation.ts";
import {
	defaultHotspotDeps,
	startHotspotLocked,
} from "./wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	type HotspotStopResult,
	stopHotspotForInterfaceLocked,
} from "./wifi-hotspot-config.ts";
import {
	type HotspotOutcomePublisher,
	publishHotspotOutcome,
} from "./wifi-hotspot-outcome.ts";
import type { HotspotStartResult } from "./wifi-hotspot-types.ts";
import { canHotspot, HOTSPOT_UP_TO } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

export {
	reconcileWifiAdapterModes,
	startWifiAdapterModeRestore,
} from "./wifi-adapter-mode-restore.ts";

/** Modes whose target state includes a live access point. */
function hostsAccessPoint(mode: WifiAdapterMode): boolean {
	return mode !== "station";
}

export interface AdapterModeTransitionDeps {
	readonly resolveInterfaces: () => Readonly<Record<string, WifiInterface>>;
	readonly readCapabilities?: (
		ifname: string,
	) => { staApCombo: { supported: boolean } } | undefined;
	readonly isAdapterBusy: (macAddress: string) => Promise<boolean>;
	readonly startHotspot: (
		device: number,
		publish: HotspotOutcomePublisher,
	) => Promise<HotspotStartResult>;
	readonly stopHotspot: (
		device: number,
		publish: HotspotOutcomePublisher,
	) => Promise<HotspotStopResult>;
	readonly publishOutcome: AdapterModeOutcomePublisher;
	readonly publishHotspotOutcome: HotspotOutcomePublisher;
	readonly persistMode: (macAddress: string, mode: WifiAdapterMode) => void;
	readonly restoreMode: (
		macAddress: string,
		previous: WifiAdapterMode | undefined,
	) => void;
	readonly readPersistedMode: (
		macAddress: string,
	) => WifiAdapterMode | undefined;
	readonly armTerminalTimeout?: (
		callback: () => void,
		delayMs: number,
	) => () => void;
}

/**
 * Was the adapter busy at this instant? Acquires and releases immediately, so it
 * never becomes the lock the delegated transaction has to contend with.
 */
async function probeAdapterBusy(macAddress: string): Promise<boolean> {
	const probe = await withWifiAdapterLock(
		wifiAdapterLockKey(macAddress),
		async () => true,
	);
	return !probe.success;
}

export const defaultAdapterModeDeps: AdapterModeTransitionDeps = {
	resolveInterfaces: getWifiInterfacesByMacAddress,
	isAdapterBusy: probeAdapterBusy,
	startHotspot: async (device, publish) => {
		const found = findAdapterByDevice(device, getWifiInterfacesByMacAddress());
		const { recordIntent: _recorder, ...deps } = defaultHotspotDeps;
		const result: HotspotStartResult = !found
			? { success: false, error: "no-device" }
			: !canHotspot(found.wifiInterface)
				? { success: false, error: "unsupported" }
				: await startHotspotLocked(found.macAddress, found.wifiInterface, {
						...deps,
						publishOutcome: publish,
					});
		if (!result.success) publish("start", device, result);
		return result;
	},
	stopHotspot: async (device, publish) => {
		const found = findAdapterByDevice(device, getWifiInterfacesByMacAddress());
		const { recordIntent: _recorder, ...deps } = defaultHotspotStopDeps;
		const result: HotspotStopResult = !found
			? { success: false, error: "no-device" }
			: !canHotspot(found.wifiInterface)
				? { success: false, error: "unsupported" }
				: await stopHotspotForInterfaceLocked(
						found.macAddress,
						found.wifiInterface,
						{ ...deps, publishOutcome: publish },
					);
		publish("stop", device, result);
		return result;
	},
	publishOutcome: publishAdapterModeOutcome,
	publishHotspotOutcome,
	persistMode: persistWifiAdapterMode,
	restoreMode: restoreWifiAdapterMode,
	readPersistedMode: getPersistedWifiAdapterMode,
	armTerminalTimeout: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

function findAdapterByDevice(
	device: number | string,
	interfaces: Readonly<Record<string, WifiInterface>>,
): { macAddress: string; wifiInterface: WifiInterface } | undefined {
	const id = typeof device === "number" ? device : Number.parseInt(device, 10);
	if (Number.isNaN(id)) return undefined;
	for (const macAddress in interfaces) {
		const wifiInterface = interfaces[macAddress];
		if (wifiInterface?.id === id) return { macAddress, wifiInterface };
	}
	return undefined;
}

/**
 * Forward the hotspot's own terminal outcome AND settle the mode change with it,
 * at most once. The hotspot frame is still published by exactly the branch that
 * always published it; this only adds the mode's terminal beside it.
 */
function chainModeTerminal(
	device: number,
	target: WifiAdapterMode,
	deps: AdapterModeTransitionDeps,
): HotspotOutcomePublisher {
	let settled = false;
	const cancelTimeout = deps.armTerminalTimeout?.(() => {
		if (settled) return;
		settled = true;
		deps.publishOutcome(device, { success: false, error: "not-confirmed" });
	}, HOTSPOT_UP_TO * 1000);
	return (kind, hotspotDevice, outcome) => {
		deps.publishHotspotOutcome(kind, hotspotDevice, outcome);
		if (settled) return;
		settled = true;
		cancelTimeout?.();
		deps.publishOutcome(
			device,
			outcome.success
				? { success: true, mode: target }
				: { success: false, error: outcome.error },
		);
	};
}

function refuse(
	device: number | string,
	error: WifiAdapterModeError,
	deps: AdapterModeTransitionDeps,
): SetWifiAdapterModeOutput {
	deps.publishOutcome(device, { success: false, error });
	return { success: false, error };
}

/**
 * Switch one adapter to `target`.
 *
 * The persisted preference is written BEFORE the radio is touched (so a device
 * that dies mid-transition comes back trying for the operator's mode) and
 * RESTORED when NetworkManager synchronously refuses. A `not-confirmed` outcome
 * deliberately KEEPS the preference: NetworkManager accepted the activation and
 * merely never reported the AP up, so the radio may still reach the mode — and
 * discarding the operator's stated intent there would also stop the next boot
 * from retrying it.
 */
export async function setWifiAdapterMode(
	device: number | string,
	target: WifiAdapterMode,
	providedDeps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
): Promise<SetWifiAdapterModeOutput> {
	const binding = captureWifiFrameIncarnation(device, "mode");
	const deps: AdapterModeTransitionDeps = {
		...providedDeps,
		publishOutcome: (publishedDevice, outcome) =>
			withWifiFrameIncarnation(binding, () =>
				providedDeps.publishOutcome(publishedDevice, outcome),
			),
	};
	const found = findAdapterByDevice(device, deps.resolveInterfaces());
	if (!found) return refuse(device, "no-device", deps);

	const { macAddress, wifiInterface } = found;
	if (await deps.isAdapterBusy(macAddress)) {
		return refuse(wifiInterface.id, "DEVICE_BUSY", deps);
	}
	const lock = await withWifiAdapterLock(
		wifiAdapterLockKey(macAddress),
		async (): Promise<SetWifiAdapterModeOutput> => {
			const options = wifiAdapterModeOptions(
				wifiAdapterModeCapability(wifiInterface, deps.readCapabilities),
			);
			if (!isWifiAdapterModeAvailable(target, options)) {
				const reason = options.find((option) => option.mode === target)?.reason;
				return refuse(
					wifiInterface.id,
					reason === "unsupported" ? "unsupported" : "capability-unproven",
					deps,
				);
			}

			const current = observedWifiAdapterMode(wifiInterface);
			if (current === target) {
				// Already there: nothing is dispatched, so no confirmation will ever
				// settle and this branch owes the terminal frame itself. The preference is
				// still recorded — the operator has now stated it explicitly.
				deps.persistMode(resolveWifiAdapterModeIntentKey(macAddress), target);
				deps.publishOutcome(wifiInterface.id, { success: true, mode: target });
				return { success: true, applied: target };
			}

			if (
				target === "hotspot" &&
				current !== "hotspot" &&
				wifiInterface.conn &&
				getIsStreaming()
			) {
				logger.warn(
					`wifi mode switch: streaming keeps the station link on ${wifiInterface.ifname}`,
				);
				return refuse(wifiInterface.id, "DEVICE_BUSY", deps);
			}

			const undo = recordWifiAdapterModeIntent(
				resolveWifiAdapterModeIntentKey(macAddress),
				target,
				{
					read: deps.readPersistedMode,
					persist: deps.persistMode,
					restore: deps.restoreMode,
				},
			);
			let succeeded = false;
			try {
				deps.publishOutcome(wifiInterface.id, { pending: true, mode: target });

				// Leaving an AP mode always tears the current one down first. For a
				// hotspot<->hybrid switch that teardown is a step rather than the outcome, so
				// it publishes only the hotspot's own frame and the mode's terminal is still
				// owed by the start that follows.
				if (hostsAccessPoint(current)) {
					const stopped = await deps.stopHotspot(
						wifiInterface.id,
						hostsAccessPoint(target)
							? deps.publishHotspotOutcome
							: chainModeTerminal(wifiInterface.id, target, deps),
					);
					if (!stopped.success) {
						if (hostsAccessPoint(target)) {
							deps.publishOutcome(wifiInterface.id, {
								success: false,
								error: stopped.error,
							});
						}
						return { success: false, error: stopped.error };
					}
					if (!hostsAccessPoint(target)) {
						succeeded = true;
						return { success: true, applied: target };
					}
				}

				const started = await deps.startHotspot(
					wifiInterface.id,
					chainModeTerminal(wifiInterface.id, target, deps),
				);
				if (!started.success) {
					return { success: false, error: started.error };
				}
				succeeded = true;
				return { success: true, accepted: true, applied: target };
			} finally {
				if (!succeeded) undo();
			}
		},
	);
	return lock.success
		? lock.result
		: refuse(wifiInterface.id, lock.error, deps);
}
