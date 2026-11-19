// allow: SIZE_OK - one pending-activation state machine keeps cancellation, instance proof and terminal publication together.
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
import {
	nmcliParseSep,
	nmDeviceProp,
	nmDevices,
} from "../network/network-manager.ts";
import {
	type NmProfileInstance,
	sameNmProfileActivation,
	sameNmProfileInstance,
} from "../network/network-manager-profile-instance.ts";
import type { MonitorEvent, WifiState } from "../network/state-types.ts";
import {
	getModeForInterface,
	getWifiState,
	setWifiState,
} from "./state/wifi-state.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "./wifi-adapter-lock.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import type {
	HotspotActivationDeps,
	HotspotActivationInstance,
	HotspotConfirmationTarget,
	WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import type { WifiInterface } from "./wifi-interfaces.ts";
import {
	matchesWifiOperationRadio,
	sampleWifiOperationRadio,
	type WifiOperationBinding,
} from "./wifi-operation-binding.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";
import type { RadioSample } from "./wifi-radio-read-budget.ts";
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
	readonly uuid: string;
	activation: HotspotActivationInstance | undefined;
	readonly ifname: string;
	readonly apIfname: string;
	readonly connName: string;
	readonly row: WifiInterfaceWithHotspot;
	readonly controller: AbortController;
	readonly matches: () => boolean;
	readonly probe: () => Promise<boolean>;
	readonly confirm: () => void;
	readonly giveUp: (changed?: { readonly stopped: boolean }) => void;
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

/** Existing pending snapshots are the only in-process confirmation evidence. */
export function getPendingHotspotProfile(
	uuid: string,
): NmProfileInstance | undefined {
	for (const pending of pendingHotspots.values())
		if (
			pending.uuid === uuid &&
			current(pending) &&
			pending.matches() &&
			pending.activation?.profile?.file
		)
			return pending.activation.profile;
	return undefined;
}

/** Only the shared keyfile-write readback calls this; explicit new intents cancel their old frame. */
export function recordPendingHotspotModify(
	uuid: string,
	before: NmProfileInstance | null | undefined,
	after: NmProfileInstance,
): void {
	for (const pending of pendingHotspots.values()) {
		if (
			pending.uuid !== uuid ||
			!current(pending) ||
			!pending.matches() ||
			!sameNmProfileActivation(pending.activation?.profile, before) ||
			!sameNmProfileInstance(before, after)
		)
			continue;
		pending.activation = {
			profile: after,
			activePath: pending.activation?.activePath,
		};
	}
}

function settleCaptured(
	pending: PendingHotspot,
	confirmed: boolean,
	changed?: { readonly stopped: boolean },
): void {
	if (!current(pending)) return;
	const exact = !confirmed || pending.matches();
	pending.controller.abort();
	pendingHotspots.delete(pending.ifname);
	pendingByRow.delete(pending.row);
	if (confirmed && exact) pending.confirm();
	else pending.giveUp(changed);
}

/** Trusted settlement/cancellation of the current pending operation. */
export function settlePending(ifname: string, confirmed: boolean): void {
	const pending = pendingHotspots.get(ifname);
	if (pending) settleCaptured(pending, confirmed);
}

/** Supersede older observers before another transaction owns the transition. */
export function beginHotspotTransition(
	wifiInterface: WifiInterfaceWithHotspot,
	transition: NonNullable<WifiInterfaceWithHotspot["hotspot"]["transition"]>,
): void {
	for (const previous of [
		pendingByRow.get(wifiInterface),
		pendingHotspots.get(wifiInterface.ifname),
	]) {
		if (!previous) continue;
		previous.controller.abort();
		if (pendingHotspots.get(previous.ifname) === previous)
			pendingHotspots.delete(previous.ifname);
		if (pendingByRow.get(previous.row) === previous)
			pendingByRow.delete(previous.row);
	}
	wifiInterface.hotspot.transition = transition;
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
	target: HotspotConfirmationTarget & {
		readonly macAddress: string;
		readonly binding?: WifiOperationBinding | undefined;
		readonly targetRadio?: RadioSample | undefined;
	},
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotActivationDeps,
): void {
	transitionVirtualBinding(wifiInterface, { kind: "associate" });
	const ifname = wifiInterface.ifname;
	const hotspot = wifiInterface.hotspot;
	const device = wifiInterface.id;
	const owner = target.credentialOwner ?? target.macAddress;
	const controller = new AbortController();
	const virtual = target.ifname !== ifname;
	const lifetime = wifiRadioIdentity.state.rows.get(ifname)?.lifetime;
	const apLifetime = wifiRadioIdentity.state.rows.get(target.ifname)?.lifetime;
	const binding = target.binding;
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
		deps.credentials.clearCreation?.(owner, target.uuid);
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
	const giveUp: PendingHotspot["giveUp"] = (changed) => {
		if (
			wifiInterface.hotspot === hotspot &&
			(!binding || getWifiInterfaceByMacAddress(binding.key) === wifiInterface)
		) {
			delete hotspot.transition;
			if (ownsCache()) {
				const binding = wifiInterface.concurrentHotspot;
				if (
					(!changed || changed.stopped) &&
					virtual &&
					binding?.ifname === target.ifname &&
					(binding.activeConn === null || binding.activeConn === target.uuid)
				)
					transitionVirtualBinding(wifiInterface, { kind: "clear" });
				if (!virtual) deps.setDupIpSuppression(ifname, false);
			}
			deps.broadcastState();
			syncWifiStateCache(target.macAddress, wifiInterface);
		}
		deps.publishOutcome?.("start", device, {
			success: false,
			error: changed ? "radio-changed" : "not-confirmed",
			...(changed && !changed.stopped ? { reason: "deactivation-failed" } : {}),
		});
	};
	const exactActivation = async (activation: HotspotActivationInstance) => {
		if (
			!activation.activePath ||
			!sameNmProfileActivation(
				activation.profile,
				await deps.readProfileInstance?.(target.uuid),
			)
		)
			return false;
		const state = await nmDeviceProp(
			target.ifname,
			"GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH",
		);
		return (
			Number.parseInt(state?.[0] ?? "", 10) === 100 &&
			state?.[1] === target.uuid &&
			state?.[2] === activation.activePath
		);
	};
	let flight: Promise<boolean> | undefined;
	const probe = (): Promise<boolean> => {
		if (!current(pending) || !(binding ? ownsCache() : matches()))
			return Promise.resolve(false);
		flight ??= Promise.resolve()
			.then(async () => {
				if (
					deps.pollHotspotActive &&
					!(await deps.pollHotspotActive(
						wifiInterface,
						target.uuid,
						target.ifname,
						pending.activation,
					))
				)
					return false;
				if (!current(pending) || !(binding ? ownsCache() : matches()))
					return false;
				const rows = await nmDevices("device,type,state,con-uuid");
				const up =
					rows?.some((raw) => {
						const [apIfname, type, state, uuid] = nmcliParseSep(raw);
						return (
							apIfname === target.ifname &&
							type === "wifi" &&
							(state === "connected" || state === "connected (externally)") &&
							uuid === target.uuid
						);
					}) ?? false;
				if (!up || !current(pending) || !(binding ? ownsCache() : matches()))
					return false;
				const activation = pending.activation;
				const exact = activation?.profile || activation?.activePath;
				if (exact && !(await exactActivation(activation))) return false;
				if (!binding || !current(pending)) return current(pending) && matches();
				const targetLifetime = target.targetRadio?.lifetime ?? apLifetime;
				const radio =
					virtual && targetLifetime
						? await sampleWifiOperationRadio(target.ifname)
						: undefined;
				const parent = await sampleWifiOperationRadio(binding.ifname);
				if (
					!current(pending) ||
					!ownsCache() ||
					pending.activation !== activation
				)
					return false;
				if (!parent || (virtual && targetLifetime && !radio)) return false;
				const sameTarget =
					!virtual ||
					!targetLifetime ||
					sameRadioLifetime(targetLifetime, radio?.lifetime);
				if (sameTarget && matchesWifiOperationRadio(binding, parent)) {
					settleCaptured(pending, true);
					return true;
				}
				// The absence of a witness is not evidence that the activated leg changed.
				const physicalChange =
					!sameTarget ||
					!sameRadioLifetime(binding.lifetime, parent.lifetime) ||
					(!parent.macReadFailed && parent.permanentMac !== binding.mac);
				if (!physicalChange || !exact || !activation) return false;
				const lock = await withWifiAdapterLock(
					wifiAdapterLockKey(owner),
					async () => {
						if (
							!current(pending) ||
							!ownsCache() ||
							pending.activation !== activation ||
							!(await exactActivation(activation)) ||
							!current(pending) ||
							!ownsCache() ||
							pending.activation !== activation
						)
							return false;
						const stopped = await deps.nmDisconnect(target.uuid);
						settleCaptured(pending, false, { stopped });
						return true;
					},
				);
				return lock.success && lock.result;
			})
			.finally(() => {
				flight = undefined;
			});
		return flight;
	};
	const pending: PendingHotspot = {
		uuid: target.uuid,
		activation: target.activation,
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
	pendingHotspots.set(ifname, pending);
	pendingByRow.set(wifiInterface, pending);
	if (deps.pollHotspotActive) {
		retryWithBackoff(
			async () => {
				if (!current(pending)) return true;
				if (await probe()) {
					settleCaptured(pending, true);
					return true;
				}
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
