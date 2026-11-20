import { logger } from "../../helpers/logger.ts";
import {
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmDeviceProp,
	nmDisconnect,
} from "../network/network-manager.ts";
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
	confirmHybridActivation,
	HYBRID_CHANNEL_REFUSAL,
	readHybridStationChannel,
	readHybridTargetIdentity,
	releaseConcurrentApInterface,
	releaseCreatedHybridTarget,
	revalidateConcurrentApInterface,
	selectConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import { runHotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";
import {
	canHotspot,
	HOTSPOT_UP_TO,
	type HotspotStartResult,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	type HybridChannelRefusal,
	type HybridRestoreAttempt,
	type HybridTargetRefusal,
	logHybridChannelRefusal,
	logHybridTargetRefusal,
} from "./wifi-hybrid-target-diagnostics.ts";

/** Boot-only D12 path. Requests never receive this activation authority. */
export async function restoreLimitedHotspot(
	row: WifiInterfaceWithHotspot,
	deps: AdapterModeTransitionDeps,
	readPreferences: typeof getPersistedWifiAdapterModes,
	stopped: () => boolean = () => false,
	restoreAttempt?: HybridRestoreAttempt,
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
	const refuseHybrid = (reason: string): HotspotStartResult => {
		refuse(reason);
		const result = {
			success: false,
			error: "activation-failed",
			reason: HYBRID_CHANNEL_REFUSAL,
		} as const;
		deps.publishHotspotOutcome("start", row.id, result);
		return result;
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
	let hybridUnavailable = false;
	const admitted = (reject = refuse): boolean => {
		if (stopped()) return false;
		const current = Object.values(deps.resolveInterfaces()).filter(canHotspot);
		if (current.length !== 1 || current[0] !== row)
			return reject("requires exactly one hotspot-capable adapter");
		if (
			row.degradedReason !== "permanent-mac-unresolved" ||
			observedWifiAdapterMode(row) !== "station" ||
			row.hotspot.transition
		)
			return reject("adapter is no longer eligible");
		const latest = readPreferences();
		if (
			resolveWifiAdapterModeIntentKey("limited", latest, 1) !== key ||
			latest[key] !== desired
		)
			return reject("logical intent changed");
		refreshHotspotChannels(row.hotspot, getDerivedApChannels());
		if (
			desired !== "hybrid" &&
			channel !== "auto" &&
			!row.hotspot.availableChannels.includes(channel)
		)
			return reject("stored channel is no longer permitted");
		const concurrency = wifiAdapterModeCapability(
			row,
			deps.readCapabilities,
		).staApComboSupported;
		if (desired === "hybrid" && concurrency !== true) {
			hybridUnavailable = true;
			return reject("hybrid capability is not proven");
		}
		if (desired === "hybrid" && fields[3] !== concurrentApIfname(row.ifname))
			return reject("owned profile does not target the hybrid interface");
		if (desired === "hotspot" && row.conn && getIsStreaming())
			return reject("streaming keeps the station link");
		return true;
	};
	if (!admitted())
		return hybridUnavailable
			? refuseHybrid("hybrid capability is not proven")
			: undefined;
	let target: ConcurrentApInterface | undefined;
	let targetIdentity: string | undefined;
	let accepted = false;
	const restoreUuid = stored.conn;
	const disconnectSelected = async () => {
		if (!target || !targetIdentity) return;
		await runHotspotProfileOperation({
			uuid: restoreUuid,
			kind: "down",
			run: async () => {
				if (
					!target ||
					!canUseHotspotConnection(key, restoreUuid) ||
					(await readHybridTargetIdentity(row.ifname, target.ifname)) !==
						targetIdentity ||
					(await nmDeviceProp(target.ifname, "GENERAL.CON-UUID"))?.[0] !==
						restoreUuid
				)
					return false;
				return nmDisconnect(restoreUuid);
			},
		});
	};
	let channelRefusal: HybridChannelRefusal | undefined;
	const readChannel = () => {
		channelRefusal = undefined;
		return readHybridStationChannel(row.ifname, (refusal) => {
			channelRefusal = refusal;
		});
	};
	const logChannel = (
		reason: string,
		revalidation?: Parameters<typeof logHybridChannelRefusal>[5],
	): false => {
		if (!refusalLogged) {
			logHybridChannelRefusal(
				`limited restore: ${reason} on ${row.ifname}`,
				row.ifname,
				"limited-restore",
				restoreAttempt,
				channelRefusal,
				revalidation,
			);
			refusalLogged = true;
		}
		return false;
	};
	try {
		const hybridChannel =
			desired === "hybrid" ? await readChannel() : undefined;
		if (desired === "hybrid" && !hybridChannel) {
			logChannel("hybrid-channel-not-permitted");
			return refuseHybrid("hybrid-channel-not-permitted");
		}
		if (desired === "hybrid") {
			let targetRefusal: HybridTargetRefusal | undefined;
			target = await selectConcurrentApInterface(
				row.ifname,
				admitted,
				true,
				(refusal) => {
					targetRefusal = refusal;
				},
			);
			if (!admitted()) return undefined;
			if (!target) {
				if (!refusalLogged) {
					logHybridTargetRefusal(
						`limited restore: hybrid interface is unavailable on ${row.ifname}`,
						row.ifname,
						"limited-restore",
						true,
						restoreAttempt,
						targetRefusal,
					);
					refusalLogged = true;
				}
				return refuseHybrid("hybrid interface is unavailable");
			}
			const selectedIfname = target.ifname;
			if (
				!(
					await runHotspotProfileOperation({
						uuid: restoreUuid,
						kind: "modify",
						fields: {
							"connection.interface-name": selectedIfname,
							"802-11-wireless.mac-address": "",
							"match.path": "",
							"connection.autoconnect": "no",
							"connection.autoconnect-priority": "999",
							...hybridChannel?.fields,
						},
						run: (fields) => nmConnSetFields(restoreUuid, fields),
					})
				).success
			)
				return pending("hybrid profile binding failed");
			const initialFrequency = hybridChannel?.frequency;
			if (
				!admitted((reason: string) =>
					logChannel(reason, { subReason: "admission-lost", initialFrequency }),
				)
			) {
				logChannel("hybrid-channel-not-permitted", {
					subReason: "admission-lost",
					initialFrequency,
				});
				return refuseHybrid("hybrid-channel-not-permitted");
			}
			if (!(await revalidateConcurrentApInterface(target))) {
				logChannel("hybrid-channel-not-permitted", {
					subReason: "target-no-longer-valid",
					initialFrequency,
				});
				return refuseHybrid("hybrid-channel-not-permitted");
			}
			const observed = await readChannel();
			if (observed?.identity !== hybridChannel?.identity) {
				logChannel("hybrid-channel-not-permitted", {
					subReason: "station-channel-changed",
					initialFrequency,
					observedFrequency: observed?.frequency,
				});
				return refuseHybrid("hybrid-channel-not-permitted");
			}
		}
		if (!canUseHotspotConnection(key, stored.conn))
			return pending("profile ownership changed");
		if (target) {
			targetIdentity = await readHybridTargetIdentity(
				row.ifname,
				target.ifname,
			);
			if (!targetIdentity || !admitted())
				return pending("hybrid target identity unavailable");
		}
		const activated = (
			await runHotspotProfileOperation({
				uuid: restoreUuid,
				kind: "up",
				run: async () => {
					if (
						target &&
						(!admitted() ||
							(await readHybridTargetIdentity(row.ifname, target.ifname)) !==
								targetIdentity ||
							(await readHybridStationChannel(row.ifname))?.identity !==
								hybridChannel?.identity ||
							!(await revalidateConcurrentApInterface(target)))
					)
						return false;
					return nmConnect(restoreUuid, HOTSPOT_UP_TO);
				},
			})
		).success;
		if (stopped()) {
			if (activated) await disconnectSelected();
			return undefined;
		}
		if (!activated) {
			refuse("activation failed");
			return { success: false, error: "activation-failed" };
		}
		if (
			target &&
			hybridChannel &&
			!(await confirmHybridActivation(
				row.ifname,
				target.ifname,
				stored.conn,
				hybridChannel,
			))
		) {
			await disconnectSelected();
			return pending("hybrid activation was not confirmed");
		}
		accepted = true;
		logger.warn("hotspot restored on an adapter that could not be identified");
		return { success: true };
	} finally {
		if (!accepted && target) {
			await releaseConcurrentApInterface(target.ifname);
			if (target.created) await releaseCreatedHybridTarget(target);
		}
	}
}
