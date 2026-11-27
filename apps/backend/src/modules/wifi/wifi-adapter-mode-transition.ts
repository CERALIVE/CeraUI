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
	awaitWifiStopHandoff,
	wifiAdapterLockKey,
	withWifiAdapterLock,
	withWifiAdapterLocks,
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
import {
	reconcileWifiAdapterModeLocked,
	wifiStopTarget,
} from "./wifi-adapter-reconciler.ts";

export { defaultAdapterModeDeps } from "./wifi-adapter-mode-deps.ts";

import {
	tryRecordWifiStationIntent,
	type WifiAdapterModeRecorder,
} from "./wifi-adapter-mode-intent.ts";
import { resolveWifiAdapterOwner } from "./wifi-adapter-owner.ts";
import { admitWifiRequest, withoutWifiRequestBinding } from "./wifi-binding.ts";
import { getWifiCapabilitiesForInterface } from "./wifi-capabilities.ts";
import {
	HYBRID_CHANNEL_REFUSAL,
	type readHybridStationChannel,
} from "./wifi-concurrent-interface.ts";
import { captureWifiFrameIncarnation } from "./wifi-frame-binding.ts";
import { withWifiFrameIncarnation } from "./wifi-frame-incarnation.ts";
import type { HotspotStopResult } from "./wifi-hotspot-config.ts";
import type { HotspotOutcomePublisher } from "./wifi-hotspot-outcome.ts";
import type { HotspotStartResult } from "./wifi-hotspot-types.ts";
import { canHotspot, HOTSPOT_UP_TO } from "./wifi-hotspot-types.ts";
import type { HybridRestoreAttempt } from "./wifi-hybrid-target-diagnostics.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { takeWifiModeRequestRefusal } from "./wifi-mode-request.ts";
import { trackWifiModeWitness } from "./wifi-mode-witness.ts";
import {
	bindingForRow,
	verifiedWifiPortKey,
	type WifiOperationBinding,
	wifiOperationChanged,
	wifiOperationGuard,
} from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac } from "./wifi-permanent-mac.ts";

export {
	reconcileWifiAdapterModes,
	startWifiAdapterModeRestore,
} from "./wifi-adapter-mode-restore.ts";

export interface AdapterModeTransitionDeps {
	readonly readHybridChannel?: typeof readHybridStationChannel;
	readonly resolveInterfaces: () => Readonly<Record<string, WifiInterface>>;
	readonly readCapabilities?: (
		ifname: string,
	) => { staApCombo: { supported: boolean } } | undefined;
	readonly isAdapterBusy: (macAddress: string) => Promise<boolean>;
	readonly startHotspot: (
		device: number,
		publish: HotspotOutcomePublisher,
		restoreAttempt?: HybridRestoreAttempt,
		binding?: WifiOperationBinding,
	) => Promise<HotspotStartResult>;
	readonly stopHotspot: (
		device: number,
		publish: HotspotOutcomePublisher,
		binding?: WifiOperationBinding,
	) => Promise<HotspotStopResult>;
	readonly publishOutcome: AdapterModeOutcomePublisher;
	readonly publishHotspotOutcome: HotspotOutcomePublisher;
	readonly persistMode: WifiAdapterModeRecorder["persist"];
	readonly restoreMode: WifiAdapterModeRecorder["restore"];
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
				: {
						success: false,
						error: outcome.error,
						...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
					},
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
	if (
		target === "station" &&
		(!(await awaitWifiStopHandoff(wifiInterface)) ||
			deps.resolveInterfaces()[macAddress] !== wifiInterface)
	)
		return refuse(wifiInterface.id, "DEVICE_BUSY", publishRefusal);
	if (await deps.isAdapterBusy(macAddress)) {
		return refuse(wifiInterface.id, "DEVICE_BUSY", publishRefusal);
	}
	const stationTarget =
		target === "station" && canHotspot(wifiInterface)
			? wifiStopTarget(macAddress, wifiInterface)
			: undefined;
	const transition = async (
		binding = target === "station"
			? undefined
			: bindingForRow(macAddress, wifiInterface),
	): Promise<SetWifiAdapterModeOutput> => {
		const id = wifiInterface.id;
		const owner =
			stationTarget?.owner ??
			resolveWifiAdapterOwner(macAddress, wifiInterface);
		const intentKey = wifiAdapterKeyMac(owner)
			? owner
			: resolveWifiAdapterModeIntentKey(
					macAddress,
					undefined,
					Object.values(deps.resolveInterfaces()).filter(canHotspot).length,
				);
		if (
			target !== "station" &&
			(!wifiAdapterKeyMac(macAddress) ||
				wifiInterface.degradedReason === "permanent-mac-unresolved")
		)
			return refuse(id, "radio-unverified", publishRefusal);
		const rawCapability = (
			deps.readCapabilities ?? getWifiCapabilitiesForInterface
		)(wifiInterface.ifname);
		const capability = wifiAdapterModeCapability(
			wifiInterface,
			() => rawCapability,
		);
		const options = wifiAdapterModeOptions(capability);
		if (!isWifiAdapterModeAvailable(target, options)) {
			if (
				target === "hybrid" &&
				rawCapability?.staApCombo.supported === true &&
				capability.staApComboSupported !== true
			)
				return refuse(
					id,
					"activation-failed",
					publishRefusal,
					HYBRID_CHANNEL_REFUSAL,
				);
			const reason = options.find((option) => option.mode === target)?.reason;
			return refuse(
				id,
				reason === "unsupported" ? "unsupported" : "capability-unproven",
				publishRefusal,
			);
		}
		if (
			target === "hybrid" &&
			deps.readHybridChannel &&
			!(await deps.readHybridChannel(wifiInterface.ifname))
		)
			return refuse(
				wifiInterface.id,
				"activation-failed",
				publishRefusal,
				HYBRID_CHANNEL_REFUSAL,
			);

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

		const operation = wifiOperationGuard(binding);
		if (binding && (!(await operation.check()) || !operation.current()))
			return refuse(id, "radio-changed", publishRefusal);
		const recorder = {
			read: deps.readPersistedMode,
			persist: deps.persistMode,
			restore: deps.restoreMode,
		};
		const undo =
			target === "station"
				? tryRecordWifiStationIntent(
						intentKey,
						recorder,
						stationTarget
							? stationTarget.port
							: verifiedWifiPortKey(bindingForRow(macAddress, wifiInterface)),
					)
				: recordWifiAdapterModeIntent(
						intentKey,
						target,
						recorder,
						verifiedWifiPortKey(
							binding ?? bindingForRow(macAddress, wifiInterface),
						),
					);
		let succeeded = false;
		let awaitingTerminal = false;
		let witness: ReturnType<typeof trackWifiModeWitness> | undefined;
		const publish: AdapterModeOutcomePublisher = (device, outcome) => {
			try {
				deps.publishOutcome(device, outcome);
			} finally {
				if (!("pending" in outcome)) witness?.();
			}
		};
		const terminalDeps = { ...deps, publishOutcome: publish };
		try {
			const result = await reconcileWifiAdapterModeLocked(owner, {
				row: wifiInterface,
				target,
				publish,
				publishPending: () => {
					if (canHotspot(wifiInterface)) {
						witness = trackWifiModeWitness(wifiInterface);
					}
					publish(id, { pending: true, mode: target });
				},
				start: async () => {
					if (binding && (!(await operation.check()) || !operation.current())) {
						publish(id, wifiOperationChanged);
						return wifiOperationChanged;
					}
					const terminal = chainModeTerminal(id, target, terminalDeps);
					// The outer terminal (including timeout) owns the witness, not the Start monitor.
					return deps.startHotspot(id, terminal, undefined, binding);
				},
				stop: async (terminal) => {
					if (binding && (!(await operation.check()) || !operation.current()))
						return wifiOperationChanged;
					const publish = terminal
						? chainModeTerminal(id, target, terminalDeps)
						: deps.publishHotspotOutcome;
					return binding
						? deps.stopHotspot(id, publish, binding)
						: deps.stopHotspot(id, publish);
				},
			});
			succeeded = result.success;
			awaitingTerminal = result.success && result.accepted === true;
			return result;
		} finally {
			try {
				if (!succeeded) undo?.();
			} finally {
				if (!awaitingTerminal) witness?.();
			}
		}
	};
	const lock = stationTarget
		? await withWifiAdapterLocks(
				[
					wifiAdapterLockKey(macAddress),
					stationTarget.owner,
					...(stationTarget.port ? [stationTarget.port] : []),
				],
				() => transition(),
			)
		: await withWifiAdapterLock(
				{ registryKey: macAddress, modeTarget: wifiInterface },
				() =>
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
