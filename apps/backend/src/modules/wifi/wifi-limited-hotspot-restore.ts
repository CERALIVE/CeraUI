import { logger } from "../../helpers/logger.ts";
import { nmConnect, nmConnGetFields } from "../network/network-manager.ts";
import { nmRunId } from "../network/network-manager-profile-instance.ts";
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
	type HybridStationChannel,
	readHybridStationChannel,
	readHybridTargetIdentity,
	releaseConcurrentApInterface,
	releaseCreatedHybridTarget,
	revalidateConcurrentApInterface,
	selectConcurrentApInterface,
} from "./wifi-concurrent-interface.ts";
import {
	type NmActivationReceipt,
	nmDisconnectActivation,
} from "./wifi-hotspot-activity.ts";
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
import { sampleWifiOperationRadio } from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac, wifiAdapterKeyPort } from "./wifi-permanent-mac.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";

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
	const restoreUuid = stored.conn;
	const ownerMac = wifiAdapterKeyMac(key);
	const ownerPort = wifiAdapterKeyPort(key);
	const { ifname } = row;
	const selected = wifiRadioIdentity.state.rows.get(ifname);
	const readProfile = () =>
		nmConnGetFields(restoreUuid, [
			"802-11-wireless.mode",
			"802-11-wireless.band",
			"802-11-wireless.channel",
			"connection.interface-name",
			"match.path",
		] as const);
	const fields = await readProfile();
	if (stopped()) return undefined;
	if (fields === undefined) {
		refuse("owned AP profile missing");
		return { success: false, error: "activation-failed" };
	}
	if (fields[0] !== "ap") return pending("owned AP profile missing");
	const channel = channelFromNM(fields[1], fields[2]);
	if (desired === "hotspot" && fields[3] && fields[3] !== ifname)
		return pending("owned AP profile pins another interface");
	const portCompatible = (port: string | undefined) =>
		(!ownerPort || ownerPort === port) &&
		(!fields[4] || fields[4] === port) &&
		(Boolean(ownerPort || fields[4]) ||
			!ownerMac ||
			!wifiRadioIdentity.hasSeenSameAddressCollision(ownerMac));
	const radioStillCurrent = async () => {
		const live = await sampleWifiOperationRadio(ifname, true);
		const current = wifiRadioIdentity.state.rows.get(ifname);
		if (
			!live ||
			!selected ||
			(selected.row !== undefined && selected.row !== row) ||
			current?.incarnation !== selected.incarnation ||
			!sameRadioLifetime(selected.lifetime, live.lifetime) ||
			(live.permanentMac && live.permanentMac !== ownerMac) ||
			(selected.devicePath && selected.devicePath !== live.devicePath)
		)
			return refuse("physical radio changed or could not be rechecked");
		return (
			portCompatible(live.devicePath) ||
			refuse("available port does not prove the saved owner")
		);
	};
	const profileCurrent = async (ifname: string): Promise<boolean> => {
		const observed = await readProfile();
		return (
			(observed?.[0] === "ap" &&
				observed[1] === fields[1] &&
				observed[2] === fields[2] &&
				observed[3] === ifname &&
				observed[4] === fields[4]) ||
			refuse("owned AP profile changed")
		);
	};
	let hybridUnavailable = false;
	const admitted = (reject = refuse): boolean => {
		if (stopped()) return false;
		const current = Object.values(deps.resolveInterfaces()).filter(canHotspot);
		if (current.length !== 1 || current[0] !== row || row.ifname !== ifname)
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
		if (
			getHotspotCredentials(key)?.conn !== restoreUuid ||
			!canUseHotspotConnection(key, restoreUuid)
		)
			return reject("profile ownership changed");
		if (selected?.devicePath && !portCompatible(selected.devicePath))
			return reject("available port does not prove the saved owner");
		if (selected?.permanentMac && selected.permanentMac !== ownerMac)
			return reject(
				"available permanent address does not match the saved owner",
			);
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
		refreshHotspotChannels(row.hotspot, getDerivedApChannels());
		if (channel !== "auto" && !row.hotspot.availableChannels.includes(channel))
			return reject("stored channel is no longer permitted");
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
	let activation: NmActivationReceipt | undefined;
	let keepLeg = false;
	const disconnectSelected = async () => {
		if (!target || !targetIdentity) return false;
		const result = await runHotspotProfileOperation({
			uuid: restoreUuid,
			kind: "down",
			run: () => nmDisconnectActivation(restoreUuid, activation),
		});
		keepLeg = !result.success;
		if (keepLeg)
			logger.warn(
				"Limited hotspot restore could not verify exact deactivation",
			);
		return result.success;
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
	const compatibleStation = (station: HybridStationChannel) =>
		!station.sameChannelOnly ||
		((!fields[1] || fields[1] === station.fields["802-11-wireless.band"]) &&
			(!channel.startsWith("ch_") ||
				fields[2] === station.fields["802-11-wireless.channel"]));
	try {
		const hybridChannel =
			desired === "hybrid" ? await readChannel() : undefined;
		if (desired === "hybrid" && !hybridChannel) {
			logChannel("hybrid-channel-not-permitted");
			return refuseHybrid("hybrid-channel-not-permitted");
		}
		if (hybridChannel && !compatibleStation(hybridChannel))
			return refuseHybrid("stored profile channel conflicts with the station");
		const stationStillCurrent = async () => {
			const observed = await readChannel();
			return (
				(observed !== undefined &&
					observed.identity === hybridChannel?.identity &&
					compatibleStation(observed)) ||
				logChannel("hybrid-channel-not-permitted", {
					subReason: "station-channel-changed",
					initialFrequency: hybridChannel?.frequency,
					observedFrequency: observed?.frequency,
				})
			);
		};
		if (desired === "hybrid") {
			let targetRefusal: HybridTargetRefusal | undefined;
			target = await selectConcurrentApInterface(
				row.ifname,
				admitted,
				true,
				(refusal) => {
					targetRefusal = refusal;
				},
				{
					preserveDevicePolicy: true,
					beforeCreate: async () =>
						(await stationStillCurrent()) &&
						(await profileCurrent(fields[3])) &&
						(await radioStillCurrent()),
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
			if (target.ifname !== fields[3])
				return pending("owned profile does not target the selected interface");
			const initialFrequency = hybridChannel?.frequency;
			if (!(await revalidateConcurrentApInterface(target))) {
				logChannel("hybrid-channel-not-permitted", {
					subReason: "target-no-longer-valid",
					initialFrequency,
				});
				return refuseHybrid("hybrid-channel-not-permitted");
			}
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
			if (!(await stationStillCurrent()))
				return refuseHybrid("hybrid-channel-not-permitted");
		}
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
							!(await revalidateConcurrentApInterface(target)) ||
							!(await stationStillCurrent()))
					)
						return false;
					const runId = target ? await nmRunId() : undefined;
					if (!(await profileCurrent(target?.ifname ?? fields[3])))
						return false;
					return (
						(await radioStillCurrent()) &&
						(!target ||
							((await readHybridTargetIdentity(ifname, target.ifname)) ===
								targetIdentity &&
								(await stationStillCurrent()))) &&
						admitted() &&
						nmConnect(
							restoreUuid,
							HOTSPOT_UP_TO,
							(path) => {
								if (runId && target)
									activation = { path, runId, ifname: target.ifname };
							},
							undefined,
							target?.ifname ?? ifname,
						)
					);
				},
			})
		).success;
		if (stopped()) {
			if (target && (activated || activation)) await disconnectSelected();
			return undefined;
		}
		if (!activated) {
			if (target && activation) await disconnectSelected();
			refuse("activation failed");
			return { success: false, error: "activation-failed" };
		}
		if (
			target &&
			hybridChannel &&
			(!activation ||
				!(await confirmHybridActivation(
					row.ifname,
					target.ifname,
					stored.conn,
					hybridChannel,
					activation,
				)))
		) {
			return pending(
				(await disconnectSelected())
					? "hybrid activation was not confirmed"
					: "hybrid activation teardown was not confirmed",
			);
		}
		accepted = true;
		logger.warn("hotspot restored on an adapter that could not be identified");
		return { success: true };
	} finally {
		if (!accepted && !keepLeg && target) {
			await releaseConcurrentApInterface(target.ifname);
			if (target.created) await releaseCreatedHybridTarget(target);
		}
	}
}
