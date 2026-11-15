import { logger } from "../../helpers/logger.ts";
import { nmConnect, nmConnGetFields } from "../network/network-manager.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	canUseHotspotConnection,
	getHotspotCredentials,
} from "./hotspot-credentials.ts";
import { getDerivedApChannels, refreshHotspotChannels } from "./regdomain.ts";

import {
	type getPersistedWifiAdapterModes,
	observedWifiAdapterMode,
	resolveWifiAdapterModeIntentKey,
	wifiAdapterModeCapability,
} from "./wifi-adapter-mode.ts";

import type { AdapterModeTransitionDeps } from "./wifi-adapter-mode-transition.ts";

import { channelFromNM } from "./wifi-channels.ts";
import {
	type ConcurrentApInterface,
	concurrentApIfname,
	ensureConcurrentApInterface,
	releaseCreatedConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import {
	canHotspot,
	HOTSPOT_UP_TO,
	type HotspotStartResult,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";

/** Boot-only D12 path. Requests never receive this activation authority. */
export async function restoreLimitedHotspot(
	row: WifiInterfaceWithHotspot,
	deps: AdapterModeTransitionDeps,
	readPreferences: typeof getPersistedWifiAdapterModes,
	stopped: () => boolean = () => false,
): Promise<HotspotStartResult | undefined> {
	if (stopped()) return undefined;
	let refusalLogged = false;
	const refuse = (reason: string): false => {
		if (!refusalLogged)
			logger.warn(`limited restore: ${reason} on ${row.ifname}`);
		refusalLogged = true;
		return false;
	};
	const pending = (reason: string): undefined => {
		refuse(reason);
		return undefined;
	};
	const adapters = Object.values(deps.resolveInterfaces()).filter(canHotspot);
	if (adapters.length !== 1 || adapters[0] !== row)
		return pending("requires exactly one hotspot-capable adapter");
	const preferences = readPreferences();
	const key = resolveWifiAdapterModeIntentKey("limited", preferences, 1);
	if (!key)
		return pending("requires exactly one logical intent and profile owner");
	const desired = preferences[key];
	const stored = getHotspotCredentials(key);
	if (!stored?.conn || !canUseHotspotConnection(key, stored.conn))
		return pending("owned profile missing");
	const fields = await nmConnGetFields(stored.conn, [
		"802-11-wireless.mode",
		"802-11-wireless.band",
		"802-11-wireless.channel",
		"connection.interface-name",
	] as const);
	if (stopped()) return undefined;
	if (fields === undefined) {
		refuse("owned AP profile missing");
		return { success: false, error: "activation-failed" };
	}
	if (fields[0] !== "ap") return pending("owned AP profile missing");
	const channel = channelFromNM(fields[1], fields[2]);
	const admitted = (): boolean => {
		if (stopped()) return false;
		const current = Object.values(deps.resolveInterfaces()).filter(canHotspot);
		if (current.length !== 1 || current[0] !== row)
			return refuse("requires exactly one hotspot-capable adapter");
		if (
			row.degradedReason !== "permanent-mac-unresolved" ||
			observedWifiAdapterMode(row) !== "station" ||
			row.hotspot.transition
		)
			return refuse("adapter is no longer eligible");
		const latest = readPreferences();
		if (
			resolveWifiAdapterModeIntentKey("limited", latest, 1) !== key ||
			latest[key] !== desired
		)
			return refuse("logical intent changed");
		refreshHotspotChannels(row.hotspot, getDerivedApChannels());
		if (channel !== "auto" && !row.hotspot.availableChannels.includes(channel))
			return refuse("stored channel is no longer permitted");
		const concurrency = wifiAdapterModeCapability(
			row,
			deps.readCapabilities,
		).staApComboSupported;
		if (desired === "hybrid" && concurrency !== true)
			return refuse("hybrid capability is not proven");
		if (desired === "hybrid" && fields[3] !== concurrentApIfname(row.ifname))
			return refuse("owned profile does not target the hybrid interface");
		if (desired === "hotspot" && row.conn && getIsStreaming())
			return refuse("streaming keeps the station link");
		return true;
	};
	if (!admitted()) return undefined;
	let target: ConcurrentApInterface | undefined;
	let accepted = false;
	try {
		if (desired === "hybrid") {
			target = await ensureConcurrentApInterface(row.ifname, admitted);
			if (!admitted()) return undefined;
			if (!target) {
				refuse("hybrid interface is unavailable");
				return { success: false, error: "activation-failed" };
			}
		}
		if (!canUseHotspotConnection(key, stored.conn))
			return pending("profile ownership changed");
		const activated = await nmConnect(stored.conn, HOTSPOT_UP_TO);
		if (stopped()) return undefined;
		if (!activated) {
			refuse("activation failed");
			return { success: false, error: "activation-failed" };
		}
		accepted = true;
		logger.warn("hotspot restored on an adapter that could not be identified");
		return { success: true };
	} finally {
		if (!accepted && target?.created)
			await releaseCreatedConcurrentApInterface(target);
	}
}
