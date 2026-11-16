import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../../modules/wifi/wifi-hotspot-types.ts";

/** These suites deliver their trusted confirmation explicitly with settlePending. */
export function mockHotspotConfirmationPoll(): void {
	mockQualifiedHybridActivation();
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockResolvedValue(true);
	// These adapters do not model NM files; never probe the workstation's NM.
	spyOn(defaultHotspotDeps, "readProfileInstance").mockResolvedValue(undefined);
	spyOn(nm, "nmDevices").mockResolvedValue([]);
}

/** The caller supplies the fake allocation; these inputs establish its admitted card/channel. */
export function mockQualifiedHybridActivation(): void {
	mockQualifiedHybridDriver();
	spyOn(defaultHotspotDeps, "readHybridChannel").mockImplementation(
		qualifiedHybridEvidence.readHybridChannel,
	);
	spyOn(defaultAdapterModeDeps, "readHybridChannel").mockImplementation(
		qualifiedHybridEvidence.readHybridChannel,
	);
	spyOn(defaultHotspotDeps, "validateConcurrentInterface").mockResolvedValue(
		true,
	);
	spyOn(defaultHotspotDeps, "confirmHybridActivation").mockResolvedValue(true);
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
		nmApConnAdd: async () => "hotspot-uuid",
		nmConnDelete: async () => true,
		nmDisconnect: async () => true,
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
import { defaultAdapterModeDeps } from "../../modules/wifi/wifi-adapter-mode-deps.ts";
import { defaultHotspotDeps } from "../../modules/wifi/wifi-hotspot-activation.ts";
import {
	mockQualifiedHybridDriver,
	qualifiedHybridEvidence,
} from "./wifi-hybrid-qualification.ts";
