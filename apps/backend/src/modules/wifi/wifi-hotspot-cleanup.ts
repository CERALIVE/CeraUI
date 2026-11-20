import { logger } from "../../helpers/logger.ts";
import { nmConnsGet, nmcliParseSep } from "../network/network-manager.ts";
import type { NmProfileInstance } from "../network/network-manager-profile-instance.ts";
import { getWifiState } from "./state/wifi-state.ts";
import {
	registerWifiAdapterTeardownLocked,
	type WifiPendingTeardownResult,
} from "./wifi-adapter-reconcile-retry.ts";
import { getWifiInterfaceByMacAddress } from "./wifi-connections.ts";
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
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

type CreatedHotspotCleanup = {
	readonly uuid: string;
	readonly registryKey: string;
	readonly iface: WifiInterfaceWithHotspot;
	readonly hotspot: WifiHotspot;
	readonly activationAttempted: boolean;
	readonly instance: NmProfileInstance | null | undefined;
	readonly allocation?: { ifname: string; created: boolean };
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
	const progress: CleanupProgress = {
		instance: target.instance,
		deactivated: !target.activationAttempted,
		...(prior ? { prior } : {}),
	};
	const result = await cleanupCreatedProfile(owner, target, deps, progress);
	if (!result.complete)
		registerWifiAdapterTeardownLocked(owner, () =>
			cleanupCreatedProfile(owner, target, deps, progress),
		);
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
		gone = result.instance === null;
		replaced = !result.checked || gone;
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
	const inactive = async (): Promise<boolean | undefined> => {
		const list = await nmConnsGet("uuid,active");
		if (!list) return undefined;
		const rows = list.filter(Boolean).map(nmcliParseSep);
		if (
			rows.some(
				([id, active, extra]) =>
					!id || extra !== undefined || (active !== "yes" && active !== "no"),
			)
		)
			return undefined;
		const matching = rows.filter(([id]) => id === uuid);
		return matching.length === 1 ? matching[0]?.[1] === "no" : undefined;
	};
	const deactivated =
		!target.activationAttempted ||
		(progress.deactivated && (await inactive()) === true) ||
		(await act({ uuid, kind: "down", run: () => deps.nmDisconnect(uuid) })) ||
		(await inactive()) === true;
	progress.deactivated = deactivated;
	const deleted = prior
		? prior.cleanupConfirmed
		: await act({ uuid, kind: "delete", run: () => deps.nmConnDelete(uuid) });
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
