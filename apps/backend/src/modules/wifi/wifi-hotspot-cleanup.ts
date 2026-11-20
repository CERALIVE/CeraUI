import { logger } from "../../helpers/logger.ts";
import { nmDisconnectActivation } from "../network/network-manager.ts";
import type { NmProfileInstance } from "../network/network-manager-profile-instance.ts";
import { getWifiState } from "./state/wifi-state.ts";
import {
	registerWifiAdapterTeardownLocked,
	type WifiPendingTeardownResult,
} from "./wifi-adapter-reconcile-retry.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
import { readHotspotProfileActivity } from "./wifi-hotspot-activity.ts";
import { recordHotspotProfileDeletion } from "./wifi-hotspot-discovery-fence.ts";
import { syncWifiStateCache } from "./wifi-hotspot-monitor.ts";
import { retireHotspotProfileAuthority } from "./wifi-hotspot-profile-observation.ts";
import {
	type HotspotProfileOperation,
	runHotspotProfileOperation,
} from "./wifi-hotspot-profile-operation.ts";
import {
	canHotspot,
	type HotspotActivationDeps,
	type WifiHotspot,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	type HybridLegAllocation,
	releaseHybridLeg,
} from "./wifi-hybrid-leg-release.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

type CreatedHotspotCleanup = {
	readonly uuid: string;
	readonly registryKey: string;
	readonly iface: WifiInterfaceWithHotspot;
	readonly hotspot: WifiHotspot;
	readonly activationAttempted: boolean;
	readonly activePath?: string | undefined;
	readonly instance: NmProfileInstance | null | undefined;
	readonly allocation?: HybridLegAllocation;
};

type CleanupProgress = {
	instance: NmProfileInstance | null | undefined;
	deactivated: boolean;
	prior?: { cleanupConfirmed: boolean };
};

export async function cleanupCreatedHotspotProfile(
	owner: string,
	target: CreatedHotspotCleanup,
	deps: HotspotActivationDeps,
	prior?: { cleanupConfirmed: boolean; autoconnectDisabled: boolean },
): Promise<boolean> {
	// A caller without profile readback cannot own a durable cleanup obligation.
	if (!deps.readProfileInstance) return true;
	const progress: CleanupProgress = {
		instance: target.instance,
		deactivated: !target.activationAttempted,
		...(prior ? { prior } : {}),
	};
	const result = await cleanupCreatedProfile(owner, target, deps, progress);
	if (!result.complete)
		registerWifiAdapterTeardownLocked(owner, async () => {
			const retried = await cleanupCreatedProfile(
				owner,
				target,
				deps,
				progress,
			);
			// Start released the leg while this AP was still up; only a later Down lets it restore.
			if (retried.complete && retried.stopped && target.allocation)
				await releaseHybridLeg(target.allocation, deps, {
					receipt: true,
					deleteCreated: false,
				});
			return retried;
		});
	return result.complete;
}

async function cleanupCreatedProfile(
	owner: string,
	target: CreatedHotspotCleanup,
	deps: HotspotActivationDeps,
	progress: CleanupProgress,
): Promise<WifiPendingTeardownResult> {
	const { uuid, iface, hotspot, registryKey: macAddress } = target;
	const prior = progress.prior;
	delete progress.prior;
	let replaced = false;
	let gone = false;
	const act = async (operation: HotspotProfileOperation): Promise<boolean> => {
		if (replaced) return false;
		const result = await runHotspotProfileOperation(operation, {
			instance: progress.instance,
			readProfileInstance: deps.readProfileInstance,
			recordCreation: deps.credentials.recordCreation,
			owner,
		});
		progress.instance = result.instance;
		gone ||= result.instance === null;
		replaced ||= !result.checked || gone;
		return result.success;
	};
	const autoconnectDisabled =
		prior?.cleanupConfirmed ||
		(await act({
			uuid,
			kind: "modify",
			fields: { "connection.autoconnect": "no" },
			run: (fields) => deps.nmConnSetFields(uuid, fields),
		}));
	const activity = async () => {
		const observed = await readHotspotProfileActivity(uuid);
		if (observed === "absent") {
			replaced = true;
			gone = true;
		}
		return observed;
	};
	const deactivated =
		!target.activationAttempted ||
		(progress.deactivated && (await activity()) === "inactive") ||
		(target.activePath !== undefined &&
			(await act({
				uuid,
				kind: "down",
				run: () =>
					nmDisconnectActivation(deps.nmDisconnect, uuid, target.activePath),
			}))) ||
		(!replaced && (await activity()) === "inactive");
	progress.deactivated = deactivated;
	const deleted = prior
		? prior.cleanupConfirmed
		: deactivated &&
			(await act({
				uuid,
				kind: "delete",
				// Delete itself tears down any users of the profile, including a successor.
				run: async () =>
					(await activity()) === "inactive" && deps.nmConnDelete(uuid),
			}));
	if ((deactivated || deleted) && iface.hotspot === hotspot) {
		if (iface.conn === uuid) iface.conn = null;
		if (iface.activeConn === uuid) {
			iface.activeConn = null;
			delete iface.activeMode;
		}
		if (iface.concurrentHotspot?.activeConn === uuid)
			transitionVirtualBinding(iface, { kind: "clear" });
		delete hotspot.transition;
		if (!target.allocation) deps.setDupIpSuppression(iface.ifname, false);
		deps.broadcastState();
	}
	if (replaced) {
		if (gone) deps.credentials.clearCreation?.(owner, uuid);
		else retireHotspotProfileAuthority(owner, uuid);
		const row = getWifiInterfaceByMacAddress(macAddress);
		if (gone) {
			recordHotspotProfileDeletion(uuid);
			if (row && canHotspot(row) && row.hotspot.conn === uuid)
				delete row.hotspot.conn;
			const stored = deps.credentials.get(owner);
			if (stored?.conn === uuid) {
				const { conn: _conn, ...identity } = stored;
				deps.credentials.remember(owner, identity);
			}
		}
		// A reused UUID cannot keep the old activation's already-active shortcut.
		if (row && canHotspot(row)) {
			if (row.conn === uuid) row.conn = null;
			if (row.activeConn === uuid) {
				row.activeConn = null;
				delete row.activeMode;
			}
			if (row.concurrentHotspot?.activeConn === uuid)
				transitionVirtualBinding(row, { kind: "clear" });
			syncWifiStateCache(macAddress, row);
		}
		if (gone && row === iface && iface.hotspot === hotspot) {
			delete hotspot.transition;
			if (!target.allocation) deps.setDupIpSuppression(iface.ifname, false);
			deps.broadcastState();
		}
		return { complete: true, stopped: true };
	}
	if (!deleted) {
		if (iface.hotspot === hotspot && (!hotspot.conn || hotspot.conn === uuid)) {
			hotspot.conn = uuid;
			if (getWifiInterfaceByMacAddress(macAddress) === iface)
				syncWifiStateCache(macAddress, iface);
		}
		logger.warn(`Hotspot cleanup pending for ${uuid}`, {
			autoconnectDisabled,
			deactivated,
		});
		return { complete: false, stopped: deactivated };
	}
	recordHotspotProfileDeletion(uuid);
	deps.credentials.clearCreation?.(owner, uuid);
	if (iface.hotspot === hotspot) {
		if (hotspot.conn === uuid) delete hotspot.conn;
		if (iface.conn === uuid) iface.conn = null;
		if (iface.activeConn === uuid) {
			iface.activeConn = null;
			delete iface.activeMode;
		}
		if (iface.concurrentHotspot?.activeConn === uuid)
			transitionVirtualBinding(iface, { kind: "clear" });
		const stored = deps.credentials.get(owner);
		if (stored?.conn === uuid) {
			const { conn: _conn, ...identity } = stored;
			deps.credentials.remember(owner, identity);
		}
		const cached = getWifiState()[macAddress];
		if (
			getWifiInterfaceByMacAddress(macAddress) === iface &&
			cached &&
			canHotspot(cached) &&
			cached.hotspot === hotspot
		)
			syncWifiStateCache(macAddress, iface);
	}
	if (target.allocation?.created) {
		if (deps.rollbackConcurrentInterface)
			await deps.rollbackConcurrentInterface(target.allocation);
		else await deps.releaseConcurrentInterface?.(target.allocation.ifname);
	}
	return { complete: true, stopped: true };
}
