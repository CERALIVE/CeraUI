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
import { retryWithBackoff } from "../../helpers/retry.ts";
import { nmcliParseSep, nmDevices } from "../network/network-manager.ts";
import type { MonitorEvent, WifiState } from "../network/state-types.ts";
import {
	getModeForInterface,
	getWifiState,
	setWifiState,
} from "./state/wifi-state.ts";
import type {
	HotspotActivationDeps,
	HotspotConfirmationTarget,
	WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

// Bounded confirmation poll: a production backstop for the NM monitor event.
// Re-polls authoritative NM state until the hotspot connection is reported
// active, capped so a hotspot that never comes up rolls the transition back
// instead of hanging in `activating` forever.
/** Maximum number of retry attempts for hotspot activation confirmation poll. */
const HOTSPOT_CONFIRM_ATTEMPTS = 8;
/** Initial backoff delay (ms) for hotspot confirmation retry. */
const HOTSPOT_CONFIRM_BASE_MS = 500;
/** Maximum backoff delay (ms) for hotspot confirmation retry. */
const HOTSPOT_CONFIRM_MAX_MS = 2000;

// ─── cache sync ──────────────────────────────────────────────────────────────

/** Mirror a single interface into the MAC-keyed wifiState cache. */
export function syncWifiStateCache(
	macAddress: string,
	iface: WifiInterface,
): void {
	const prev = getWifiState();
	const next: WifiState = { ...prev };
	next[macAddress] = { ...iface, mode: getModeForInterface(iface) };
	setWifiState(next);
}

// ─── pending NM-confirmation registry ────────────────────────────────────────

type PendingHotspot = {
	readonly ifname: string;
	readonly apIfname: string;
	readonly connName: string;
	readonly row: WifiInterfaceWithHotspot;
	readonly controller: AbortController;
	readonly matches: () => boolean;
	readonly probe: () => Promise<boolean>;
	readonly confirm: () => void;
	readonly giveUp: () => void;
};

const pendingHotspots = new Map<string, PendingHotspot>();
const pendingByRow = new WeakMap<WifiInterfaceWithHotspot, PendingHotspot>();

function current(pending: PendingHotspot): boolean {
	return (
		!pending.controller.signal.aborted &&
		pendingHotspots.get(pending.ifname) === pending &&
		pendingByRow.get(pending.row) === pending
	);
}

function settleCaptured(pending: PendingHotspot, confirmed: boolean): void {
	if (!current(pending)) return;
	const exact = !confirmed || pending.matches();
	pending.controller.abort();
	pendingHotspots.delete(pending.ifname);
	pendingByRow.delete(pending.row);
	if (confirmed && exact) pending.confirm();
	else pending.giveUp();
}

/** Trusted settlement/cancellation of the current pending operation. */
export function settlePending(ifname: string, confirmed: boolean): void {
	const pending = pendingHotspots.get(ifname);
	if (pending) settleCaptured(pending, confirmed);
}

/** Events trigger selected-AP observation; names or parent connectivity are not proof. */
export async function handleWifiMonitorEvent(
	event: MonitorEvent,
): Promise<void> {
	for (const pending of pendingHotspots.values()) {
		const relevant =
			(event.type === "connection-state" &&
				event.state === "activated" &&
				event.connection === pending.connName) ||
			(event.type === "device-state" &&
				event.state === "connected" &&
				event.device === pending.apIfname);
		if (!relevant || !current(pending)) continue;
		try {
			if (await pending.probe()) settleCaptured(pending, true);
		} catch (error: unknown) {
			logger.warn("Wi-Fi AP confirmation observation failed", {
				error: error instanceof Error ? error.name : "unknown",
			});
		}
	}
}

export function registerPendingConfirmation(
	target: HotspotConfirmationTarget & { readonly macAddress: string },
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
): void {
	transitionVirtualBinding(wifiInterface, { kind: "associate" });
	const ifname = wifiInterface.ifname;
	const hotspot = wifiInterface.hotspot;
	const device = wifiInterface.id;
	const controller = new AbortController();
	const virtual = target.ifname !== ifname;
	const lifetime = wifiRadioIdentity.state.rows.get(ifname)?.lifetime;
	const apLifetime = wifiRadioIdentity.state.rows.get(target.ifname)?.lifetime;
	const ownsCache = (): boolean =>
		wifiInterface.hotspot === hotspot && hotspot.conn === target.uuid;
	const matches = (): boolean =>
		ownsCache() &&
		wifiInterface.ifname === ifname &&
		(!virtual || wifiInterface.concurrentHotspot?.ifname === target.ifname) &&
		(lifetime === undefined ||
			sameRadioLifetime(
				lifetime,
				wifiRadioIdentity.state.rows.get(ifname)?.lifetime,
			)) &&
		(apLifetime === undefined ||
			sameRadioLifetime(
				apLifetime,
				wifiRadioIdentity.state.rows.get(target.ifname)?.lifetime,
			));
	const confirm = (): void => {
		if (virtual)
			transitionVirtualBinding(wifiInterface, {
				kind: "set",
				ifname: target.ifname,
				activeConn: target.uuid,
			});
		else wifiInterface.conn = target.uuid;
		delete hotspot.transition;
		if (!virtual) deps.setDupIpSuppression(ifname, false);
		deps.broadcastState();
		syncWifiStateCache(target.macAddress, wifiInterface);
		deps.publishOutcome?.("start", device, { success: true });
	};
	const giveUp = (): void => {
		if (ownsCache()) {
			delete hotspot.transition;
			const binding = wifiInterface.concurrentHotspot;
			if (
				virtual &&
				binding?.ifname === target.ifname &&
				(binding.activeConn === null || binding.activeConn === target.uuid)
			)
				transitionVirtualBinding(wifiInterface, { kind: "clear" });
			if (!virtual) deps.setDupIpSuppression(ifname, false);
			deps.broadcastState();
			syncWifiStateCache(target.macAddress, wifiInterface);
		}
		deps.publishOutcome?.("start", device, {
			success: false,
			error: "not-confirmed",
		});
	};
	let flight: Promise<boolean> | undefined;
	const probe = (): Promise<boolean> => {
		if (!current(pending) || !matches()) return Promise.resolve(false);
		flight ??= Promise.resolve()
			.then(async () => {
				if (
					deps.pollHotspotActive &&
					!(await deps.pollHotspotActive(wifiInterface))
				)
					return false;
				if (!current(pending) || !matches()) return false;
				const rows = await nmDevices("device,type,state,con-uuid");
				return (
					rows?.some((raw) => {
						const [apIfname, type, state, uuid] = nmcliParseSep(raw);
						return (
							apIfname === target.ifname &&
							type === "wifi" &&
							(state === "connected" || state === "connected (externally)") &&
							uuid === target.uuid
						);
					}) ?? false
				);
			})
			.then((up) => up && current(pending) && matches())
			.finally(() => {
				flight = undefined;
			});
		return flight;
	};
	const pending: PendingHotspot = {
		ifname,
		apIfname: target.ifname,
		connName: hotspot.name ?? ifname,
		row: wifiInterface,
		controller,
		matches,
		probe,
		confirm,
		giveUp,
	};
	for (const previous of [
		pendingByRow.get(wifiInterface),
		pendingHotspots.get(ifname),
	]) {
		if (!previous) continue;
		previous.controller.abort();
		if (pendingHotspots.get(previous.ifname) === previous)
			pendingHotspots.delete(previous.ifname);
		if (pendingByRow.get(previous.row) === previous)
			pendingByRow.delete(previous.row);
	}
	pendingHotspots.set(ifname, pending);
	pendingByRow.set(wifiInterface, pending);
	if (deps.pollHotspotActive) {
		retryWithBackoff(
			async () => {
				if (await probe()) return true;
				throw new Error("hotspot not yet confirmed");
			},
			{
				maxAttempts: HOTSPOT_CONFIRM_ATTEMPTS,
				baseDelayMs: HOTSPOT_CONFIRM_BASE_MS,
				maxDelayMs: HOTSPOT_CONFIRM_MAX_MS,
				shouldRetry: () => current(pending) && matches(),
				signal: controller.signal,
			},
		)
			.then(() => settleCaptured(pending, true))
			.catch(() => settleCaptured(pending, false));
	}
}
