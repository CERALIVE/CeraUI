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

  IT DOES NOT HOLD THE ADAPTER LOCK ACROSS ITS WORK, and that is the whole
  reason the flow is shaped this way. `withDeviceLock` is NOT re-entrant, and the
  hotspot transactions this delegates to acquire the SAME permanent-MAC key
  themselves — so a guard held here would make every transition refuse ITSELF,
  exactly as the hotspot RPC procedures once did. This layer takes an admission
  PROBE (acquire + release) and then delegates; the transaction's own lock stays
  the guarantee.

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
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import {
	getPersistedWifiAdapterMode,
	getPersistedWifiAdapterModes,
	isWifiAdapterModeAvailable,
	observedWifiAdapterMode,
	persistWifiAdapterMode,
	restoreWifiAdapterMode,
	wifiAdapterModeCapability,
	wifiAdapterModeOptions,
} from "./wifi-adapter-mode.ts";
import {
	type AdapterModeOutcomePublisher,
	publishAdapterModeOutcome,
} from "./wifi-adapter-mode-outcome.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "./wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	type HotspotStopResult,
	wifiHotspotStop,
} from "./wifi-hotspot-config.ts";
import {
	type HotspotOutcomePublisher,
	publishHotspotOutcome,
} from "./wifi-hotspot-outcome.ts";
import type { HotspotStartResult } from "./wifi-hotspot-types.ts";
import { HOTSPOT_UP_TO } from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";

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
	startHotspot: (device, publish) =>
		wifiHotspotStart(
			{ device },
			{ ...defaultHotspotDeps, publishOutcome: publish },
		),
	stopHotspot: (device, publish) =>
		wifiHotspotStop(
			{ device },
			{ ...defaultHotspotStopDeps, publishOutcome: publish },
		),
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
	deps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
): Promise<SetWifiAdapterModeOutput> {
	const found = findAdapterByDevice(device, deps.resolveInterfaces());
	if (!found) return refuse(device, "no-device", deps);

	const { macAddress, wifiInterface } = found;
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
		deps.persistMode(macAddress, target);
		deps.publishOutcome(wifiInterface.id, { success: true, mode: target });
		return { success: true, applied: target };
	}

	if (await deps.isAdapterBusy(macAddress)) {
		return refuse(wifiInterface.id, "DEVICE_BUSY", deps);
	}

	const previous = deps.readPersistedMode(macAddress);
	deps.persistMode(macAddress, target);
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
			deps.restoreMode(macAddress, previous);
			if (hostsAccessPoint(target)) {
				deps.publishOutcome(wifiInterface.id, {
					success: false,
					error: stopped.error,
				});
			}
			return { success: false, error: stopped.error };
		}
		if (!hostsAccessPoint(target)) {
			return { success: true, applied: target };
		}
	}

	const started = await deps.startHotspot(
		wifiInterface.id,
		chainModeTerminal(wifiInterface.id, target, deps),
	);
	if (!started.success) {
		deps.restoreMode(macAddress, previous);
		return { success: false, error: started.error };
	}
	return { success: true, accepted: true, applied: target };
}

// ─── boot reconciliation (S6 fail-soft) ──────────────────────────────────────

/** How long to let the adapter registry fill before giving up on a preference. */
const RECONCILE_WAIT_ATTEMPTS = 10;
const RECONCILE_WAIT_DELAY_MS = 1000;

async function waitForAdapters(
	deps: AdapterModeTransitionDeps,
	sleep: (ms: number) => Promise<void>,
): Promise<Readonly<Record<string, WifiInterface>>> {
	let interfaces = deps.resolveInterfaces();
	for (
		let attempt = 0;
		attempt < RECONCILE_WAIT_ATTEMPTS && Object.keys(interfaces).length === 0;
		attempt++
	) {
		await sleep(RECONCILE_WAIT_DELAY_MS);
		interfaces = deps.resolveInterfaces();
	}
	return interfaces;
}

/**
 * Re-apply every stated per-adapter preference at boot.
 *
 * IDEMPOTENT: an adapter already in its stated mode is skipped without touching
 * the radio, so running this twice costs one comparison per adapter and
 * dispatches nothing.
 *
 * FAIL-SOFT: it never throws and never rejects. An adapter that is not present,
 * whose target is not currently offered, or whose transition failed is LOGGED
 * and left alone — the preference is deliberately NOT cleared, because a
 * capability read that has not landed yet must not be read as a refusal that
 * discards the operator's choice.
 */
export async function reconcileWifiAdapterModes(
	deps: AdapterModeTransitionDeps = defaultAdapterModeDeps,
	readPreferences: () => Readonly<
		Record<string, WifiAdapterMode>
	> = getPersistedWifiAdapterModes,
	sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> {
	try {
		const preferences = readPreferences();
		if (Object.keys(preferences).length === 0) return;

		const interfaces = await waitForAdapters(deps, sleep);

		for (const macAddress in preferences) {
			const desired = preferences[macAddress];
			if (desired === undefined) continue;

			const wifiInterface = interfaces[macAddress];
			if (!wifiInterface) {
				logger.debug(
					`wifi mode reconcile: no adapter for ${macAddress}; leaving ${desired} pending`,
				);
				continue;
			}

			if (observedWifiAdapterMode(wifiInterface) === desired) continue;

			const options = wifiAdapterModeOptions(
				wifiAdapterModeCapability(wifiInterface, deps.readCapabilities),
			);
			if (!isWifiAdapterModeAvailable(desired, options)) {
				logger.warn(
					`wifi mode reconcile: ${desired} is not currently offered on ${wifiInterface.ifname}; leaving the radio as it is`,
				);
				continue;
			}

			// Per adapter, so one radio that throws cannot cost every other radio
			// its reconciliation.
			try {
				const result = await setWifiAdapterMode(
					wifiInterface.id,
					desired,
					deps,
				);
				if (!result.success) {
					logger.warn(
						`wifi mode reconcile: ${wifiInterface.ifname} could not reach ${desired} (${result.error})`,
					);
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error(
					`wifi mode reconcile: ${wifiInterface.ifname} threw reaching ${desired}: ${message}`,
				);
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`wifi mode reconcile failed: ${message}`);
	}
}
