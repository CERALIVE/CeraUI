import {
	type ConnectionUUID,
	nmcliParseSep,
	nmDevices,
} from "../network/network-manager.ts";
import { concurrentApIfname } from "./wifi-concurrent-interface.ts";
import {
	nmDisconnectActivation,
	observeHotspotActivation,
	readHotspotProfileActivity,
} from "./wifi-hotspot-activity.ts";
import type {
	HotspotStopDeps,
	HotspotStopResult,
} from "./wifi-hotspot-config.ts";
import {
	beginHotspotTransition,
	settlePending,
	syncWifiStateCache,
} from "./wifi-hotspot-monitor.ts";
import { runHotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";
import {
	isHotspotActive,
	type WifiInterfaceWithHotspot,
} from "./wifi-hotspot-types.ts";
import {
	sampleWifiOperationRadio,
	wifiOperationChanged,
	type wifiOperationGuard,
} from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac } from "./wifi-permanent-mac.ts";
import { sameRadioLifetime, wifiRadioIdentity } from "./wifi-radio-identity.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

export async function teardownHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
	conn: ConnectionUUID | undefined,
	options: {
		readonly operation: ReturnType<typeof wifiOperationGuard> | undefined;
		readonly pendingCleanup: boolean;
		readonly targetIfname: string;
	},
): Promise<HotspotStopResult> {
	const { operation, pendingCleanup, targetIfname } = options;
	if (!conn) return { success: true };
	const concurrent = wifiInterface.concurrentHotspot;
	const live =
		concurrent?.activeConn === conn ||
		(wifiInterface.activeMode === "ap" && wifiInterface.activeConn === conn) ||
		isHotspotActive(wifiInterface);
	const activating = wifiInterface.hotspot.transition === "activating";
	if (!live && !activating) {
		const activity = await readHotspotProfileActivity(conn);
		if (activity === "inactive" || activity === "absent")
			return { success: true };
	}

	if (operation && (!(await operation.check()) || !operation.current()))
		return wifiOperationChanged;
	// Read BEFORE the teardown clears it: the dup-IP suppression release below has
	// to pair with whichever interface took it on the way in, and a capable radio
	// hosting an EXCLUSIVE hotspot has no virtual netdev at all.
	const virtualIfname =
		concurrent?.ifname ?? concurrentApIfname(wifiInterface.ifname);
	const identities = wifiRadioIdentity.state.rows;
	const parentPhy = identities.get(wifiInterface.ifname)?.lifetime?.phyPath;
	const ownsVirtual =
		parentPhy !== undefined &&
		identities.get(virtualIfname)?.lifetime?.phyPath === parentPhy;
	const wasConcurrent = concurrent !== undefined;
	const activeConn = wifiInterface.activeConn;
	const activeMode = wifiInterface.activeMode;
	await settlePending(wifiInterface.ifname, false);

	beginHotspotTransition(wifiInterface, "deactivating");
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);

	let dispatched = false;
	let disconnected = (
		await runHotspotProfileOperation({
			uuid: conn,
			kind: "down",
			selected: true,
			run: async () => {
				if (operation && (!(await operation.check()) || !operation.current()))
					return false;
				const roster = await nmDevices("device,type,state,con-uuid");
				const on = roster
					?.map(nmcliParseSep)
					.filter(([, type, , uuid]) => type === "wifi" && uuid === conn);
				const local = on?.find(
					([name]) =>
						name === targetIfname || (ownsVirtual && name === virtualIfname),
				);
				const ifname = local?.[0] ?? targetIfname;
				const activation = await observeHotspotActivation(conn, ifname);
				if (!activation)
					return !live && !activating && !local && Boolean(on?.length);
				const lifetime = identities.get(ifname)?.lifetime;
				return nmDisconnectActivation(conn, activation, deps, async () => {
					if (operation && !(await operation.permit())) return false;
					if (
						lifetime &&
						!sameRadioLifetime(
							lifetime,
							(await sampleWifiOperationRadio(ifname))?.lifetime,
						)
					)
						return false;
					dispatched = true;
					return true;
				});
			},
		})
	).success;
	if (!dispatched && operation?.changed) {
		delete wifiInterface.hotspot.transition;
		return wifiOperationChanged;
	}
	if (dispatched && pendingCleanup && !disconnected) {
		const activity = await readHotspotProfileActivity(conn);
		disconnected = activity === "inactive" || activity === "absent";
	}
	const result: HotspotStopResult = disconnected
		? { success: true }
		: { success: false, error: "deactivation-failed" };
	if (operation && (!(await operation.check()) || !operation.current())) {
		delete wifiInterface.hotspot.transition;
		return result;
	}
	if (disconnected) {
		const sameObservation =
			wifiInterface.activeConn === activeConn &&
			wifiInterface.activeMode === activeMode;
		if (activeConn === conn && sameObservation) {
			transitionVirtualBinding(wifiInterface, {
				kind: "parent",
				connection: null,
				mode: "unknown",
			});
			delete wifiInterface.activeConn;
			delete wifiInterface.activeMode;
		}
		if (wifiInterface.conn === conn && sameObservation) {
			wifiInterface.conn = null;
			wifiInterface.available.clear();
		}
		const current = wifiInterface.concurrentHotspot;
		if (
			current?.ifname === virtualIfname &&
			(current.activeConn === conn || current.activeConn === null)
		) {
			transitionVirtualBinding(wifiInterface, { kind: "retire" });
			if (wifiAdapterKeyMac(macAddress))
				await deps.releaseConcurrentInterface(virtualIfname);
		}
	}

	delete wifiInterface.hotspot.transition;
	if (!wasConcurrent) {
		deps.setDupIpSuppression(wifiInterface.ifname, false);
	}
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);
	void deps.rescan();
	// The transition is cleared either way, so the state broadcast above looks
	// identical for both outcomes — only this return distinguishes them.
	return result;
}
