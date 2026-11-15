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
	isWifiAdapterModeAvailable,
	observedWifiAdapterMode,
	recordWifiAdapterModeIntent,
	resolveWifiAdapterModeIntentKey,
	wifiAdapterModeCapability,
	wifiAdapterModeOptions,
} from "./wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	findAdapterByDevice,
} from "./wifi-adapter-mode-deps.ts";
import type {
	AdapterModeOutcomePublisher,
	AdapterModeRefusalPublisher,
} from "./wifi-adapter-mode-outcome.ts";
import { reconcileWifiAdapterModeLocked } from "./wifi-adapter-reconciler.ts";

export { defaultAdapterModeDeps } from "./wifi-adapter-mode-deps.ts";

import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import { admitWifiRequest, withoutWifiRequestBinding } from "./wifi-binding.ts";
import { captureWifiFrameIncarnation } from "./wifi-frame-binding.ts";
import { withWifiFrameIncarnation } from "./wifi-frame-incarnation.ts";

import type { HotspotStopResult } from "./wifi-hotspot-config.ts";
import type { HotspotOutcomePublisher } from "./wifi-hotspot-outcome.ts";
import type { HotspotStartResult } from "./wifi-hotspot-types.ts";
import { canHotspot, HOTSPOT_UP_TO } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { takeWifiModeRequestRefusal } from "./wifi-mode-request.ts";
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";

export {
	reconcileWifiAdapterModes,
	startWifiAdapterModeRestore,
} from "./wifi-adapter-mode-restore.ts";

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
	publish: AdapterModeRefusalPublisher,
	reason?: string,
): SetWifiAdapterModeOutput {
	const result = {
		success: false,
		error,
		...(reason === undefined ? {} : { reason }),
	} as const;
	publish(device, result);
	return result;
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
	const requestRefusal = takeWifiModeRequestRefusal();
	const binding = captureWifiFrameIncarnation(device, "mode");
	const deps: AdapterModeTransitionDeps = {
		...providedDeps,
		publishOutcome: (publishedDevice, outcome, reply) =>
			withWifiFrameIncarnation(binding, () =>
				reply
					? providedDeps.publishOutcome(publishedDevice, outcome, reply)
					: providedDeps.publishOutcome(publishedDevice, outcome),
			),
	};
	const publishRefusal: AdapterModeRefusalPublisher = requestRefusal
		? (publishedDevice, outcome) =>
				withoutWifiRequestBinding(() =>
					deps.publishOutcome(publishedDevice, outcome, requestRefusal),
				)
		: deps.publishOutcome;
	const found = findAdapterByDevice(device, deps.resolveInterfaces());
	if (!found) return refuse(device, "no-device", publishRefusal);

	const { macAddress, wifiInterface } = found;
	if (await deps.isAdapterBusy(macAddress)) {
		return refuse(wifiInterface.id, "DEVICE_BUSY", publishRefusal);
	}
	const transition = async (): Promise<SetWifiAdapterModeOutput> => {
		const id = wifiInterface.id;
		const owner = resolveWifiAdapterOwner(macAddress, wifiInterface);
		const intentKey = normalizeMacAddress(owner.split("@")[0])
			? owner
			: resolveWifiAdapterModeIntentKey(
					macAddress,
					undefined,
					Object.values(deps.resolveInterfaces()).filter(canHotspot).length,
				);
		if (
			target !== "station" &&
			(!normalizeMacAddress(macAddress) ||
				wifiInterface.degradedReason === "permanent-mac-unresolved")
		)
			return refuse(id, "radio-unverified", publishRefusal);
		const options = wifiAdapterModeOptions(
			wifiAdapterModeCapability(wifiInterface, deps.readCapabilities),
		);
		if (!isWifiAdapterModeAvailable(target, options)) {
			const reason = options.find((option) => option.mode === target)?.reason;
			return refuse(
				id,
				reason === "unsupported" ? "unsupported" : "capability-unproven",
				publishRefusal,
			);
		}

		const current = observedWifiAdapterMode(wifiInterface);
		if (
			target === "hotspot" &&
			current !== "hotspot" &&
			wifiInterface.conn &&
			getIsStreaming()
		) {
			logger.warn(
				`wifi mode switch: streaming keeps the station link on ${wifiInterface.ifname}`,
			);
			return refuse(id, "DEVICE_BUSY", publishRefusal);
		}

		const undo = recordWifiAdapterModeIntent(intentKey, target, {
			read: deps.readPersistedMode,
			persist: deps.persistMode,
			restore: deps.restoreMode,
		});
		let succeeded = false;
		try {
			const result = await reconcileWifiAdapterModeLocked(owner, {
				row: wifiInterface,
				target,
				publish: deps.publishOutcome,
				publishPending: () => {
					deps.publishOutcome(id, { pending: true, mode: target });
				},
				start: () => deps.startHotspot(id, chainModeTerminal(id, target, deps)),
				stop: (terminal) =>
					deps.stopHotspot(
						id,
						terminal
							? chainModeTerminal(id, target, deps)
							: deps.publishHotspotOutcome,
					),
			});
			succeeded = result.success;
			return result;
		} finally {
			if (!succeeded) undo();
		}
	};
	const lock = await withWifiAdapterLock(wifiAdapterLockKey(macAddress), () =>
		target === "station"
			? transition()
			: admitWifiRequest(wifiInterface, transition, (refusal) =>
					refuse(
						wifiInterface.id,
						refusal.error,
						publishRefusal,
						refusal.reason,
					),
				),
	);
	return lock.success
		? lock.result
		: refuse(wifiInterface.id, lock.error, publishRefusal);
}
