import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../../modules/wifi/wifi-hotspot-types.ts";

/** These suites deliver their trusted confirmation explicitly with settlePending. */
export function mockHotspotConfirmationPoll(): void {
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockResolvedValue(true);
	spyOn(nm, "nmDevices").mockResolvedValue([]);
}

export function makeHotspotIface(opts: {
	readonly ifname: string;
	readonly conn?: string | null;
	readonly hotspotConn?: string;
	readonly supportsApStaConcurrency?: boolean;
	readonly hw?: string;
}): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: opts.ifname,
		conn: opts.conn ?? null,
		hw: opts.hw ?? "Realtek RTL8812AU",
		available: new Map(),
		saved: {},
		savedAll: {},
		...(opts.supportsApStaConcurrency
			? { supportsApStaConcurrency: true }
			: {}),
		hotspot: {
			...(opts.hotspotConn ? { conn: opts.hotspotConn } : {}),
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

export function makeDeps(
	over: Partial<HotspotActivationDeps>,
): HotspotActivationDeps {
	return {
		nmConnect: async () => true,
		nmConnSetFields: async () => true,
		nmHotspot: async () => "hotspot-uuid",
		wifiUpdateSavedConns: async () => undefined,
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		credentials: { get: () => undefined, remember: () => undefined },
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => undefined,
		...over,
	};
}

import { spyOn } from "bun:test";
import * as nm from "../../modules/network/network-manager.ts";
import { defaultHotspotDeps } from "../../modules/wifi/wifi-hotspot-activation.ts";
