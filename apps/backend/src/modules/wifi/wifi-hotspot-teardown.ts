import {
	type ConnectionUUID,
	nmConnsGet,
	nmcliParseSep,
} from "../network/network-manager.ts";
import { concurrentApIfname } from "./wifi-concurrent-interface.ts";
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
import { normalizeMacAddress } from "./wifi-permanent-mac.ts";
import { transitionVirtualBinding } from "./wifi-virtual-binding.ts";

export async function teardownHotspotLocked(
	macAddress: string,
	wifiInterface: WifiInterfaceWithHotspot,
	deps: HotspotStopDeps,
	conn: ConnectionUUID | undefined,
): Promise<HotspotStopResult> {
	if (!conn) return { success: true };
	if (
		!isHotspotActive(wifiInterface) &&
		wifiInterface.hotspot.transition !== "activating"
	) {
		const connections = await nmConnsGet("uuid,active");
		if (
			connections?.every((raw) => {
				if (!raw) return true;
				const [uuid, active] = nmcliParseSep(raw);
				return (
					Boolean(uuid) &&
					(active === "yes" || active === "no") &&
					(uuid !== conn || active === "no")
				);
			})
		)
			return { success: true };
	}

	// Read BEFORE the teardown clears it: the dup-IP suppression release below has
	// to pair with whichever interface took it on the way in, and a capable radio
	// hosting an EXCLUSIVE hotspot has no virtual netdev at all.
	const concurrent = wifiInterface.concurrentHotspot;
	const virtualIfname =
		concurrent?.ifname ?? concurrentApIfname(wifiInterface.ifname);
	const wasConcurrent = concurrent !== undefined;
	const activeConn = wifiInterface.activeConn;
	const activeMode = wifiInterface.activeMode;
	settlePending(wifiInterface.ifname, false);

	beginHotspotTransition(wifiInterface, "deactivating");
	deps.broadcastState();
	syncWifiStateCache(macAddress, wifiInterface);

	const disconnected = (
		await runHotspotProfileOperation({
			uuid: conn,
			kind: "down",
			selected: true,
			run: () => deps.nmDisconnect(conn),
		})
	).success;
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
			if (normalizeMacAddress(macAddress))
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
	return disconnected
		? { success: true }
		: { success: false, error: "deactivation-failed" };
}
