import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotOutcomeKind,
	HotspotToggleOutcome,
} from "../modules/wifi/wifi-hotspot-outcome.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	makeDeps,
	makeHotspotIface,
} from "./helpers/wifi-hotspot-test-setup.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const MAC = "dc:a6:32:7e:01:01";
const inherited = isolateWifiRegistry();
afterEach(() => {
	delete getWifiIdToMacAddress()[0];
	setWifiState({});
	restoreWifiRegistry(inherited);
});

describe("hotspot start — the accepted path is settled by a LATER frame", () => {
	test("an NM-confirmed activation publishes success exactly once", async () => {
		const iface = makeHotspotIface({
			ifname: "wlan2",
			hw: "Realtek RTL8852BE",
		});
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;
		setWifiState({ [MAC]: { ...iface, mode: "station" } });
		onWifiChange(() => {});
		const published: Array<{
			kind: HotspotOutcomeKind;
			device: number | string;
			outcome: HotspotToggleOutcome;
		}> = [];
		const result = await wifiHotspotStart(
			{ device: 0 },
			makeDeps({
				publishOutcome: (kind, device, outcome) =>
					published.push({ kind, device, outcome }),
				wifiUpdateSavedConns: async () => {
					iface.hotspot.conn = "hotspot-uuid";
				},
			}),
		);
		expect(result).toEqual({ success: true });
		expect(published).toEqual([]);

		const observation = spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan2:wifi:connected:hotspot-uuid",
		]);
		try {
			await handleWifiMonitorEvent({
				type: "connection-state",
				connection: iface.hotspot.name ?? "",
				state: "activated",
			});
		} finally {
			observation.mockRestore();
		}

		expect(published).toEqual([
			{ kind: "start", device: 0, outcome: { success: true } },
		]);
		expect(getWifiState()[MAC]?.mode).toBe("hotspot");
	});
});
