import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { StateDiff } from "../modules/network/state-types.ts";
import {
	onWifiChange,
	setWifiState,
	type WifiDiffEntry,
} from "../modules/wifi/state/wifi-state.ts";
import {
	type WifiInterfaceResponseMessage,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	handleWifiMonitorEvent,
	removeWifiInterface,
	setScanRefreshAction,
	WIFI_SCAN_REFRESH_DEBOUNCE_MS,
	wifiCancelScanRefresh,
	wifiPendingScanRefreshCount,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";

type FakeTimer = {
	id: number;
	fn: () => void;
	delay: number;
	cleared: boolean;
};

describe("wifi debounced scan refresh (hard cutover from the 6-timer schedule)", () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timers: Map<number, FakeTimer>;
	let nextId: number;

	beforeEach(() => {
		timers = new Map();
		nextId = 1;
		globalThis.setTimeout = ((fn: () => void, delay?: number) => {
			const id = nextId++;
			timers.set(id, { id, fn, delay: delay ?? 0, cleared: false });
			return id as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
			const timer = timers.get(id as unknown as number);
			if (timer) timer.cleared = true;
		}) as typeof clearTimeout;
	});

	afterEach(() => {
		wifiCancelScanRefresh();
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
		setScanRefreshAction(wifiUpdateScanResult);
	});

	it("collapses 3 rapid rescans into a single pending timer + one scan", () => {
		let scans = 0;
		setScanRefreshAction(() => {
			scans++;
		});

		wifiScheduleScanRefresh();
		wifiScheduleScanRefresh();
		wifiScheduleScanRefresh();

		const live = [...timers.values()].filter((timer) => !timer.cleared);
		expect(live).toHaveLength(1);
		expect(wifiPendingScanRefreshCount()).toBe(1);
		expect(live[0]?.delay).toBe(WIFI_SCAN_REFRESH_DEBOUNCE_MS);

		const cleared = [...timers.values()].filter((timer) => timer.cleared);
		expect(cleared).toHaveLength(2);

		expect(scans).toBe(0);
		live[0]?.fn();
		expect(scans).toBe(1);
		expect(wifiPendingScanRefreshCount()).toBe(0);
	});
});

describe("wifi connection-state event flips to connected", () => {
	const MAC = "aa:bb:cc:dd:ee:01";

	afterEach(() => {
		removeWifiInterface(MAC);
		setWifiState({});
		onWifiChange(() => {});
	});

	it("emits one diff broadcast marking the interface connected", () => {
		const wifiInterface: WifiInterface = {
			id: 0,
			ifname: "wlan0",
			conn: null,
			hw: "Test Adapter",
			available: new Map([
				[
					"MySSID",
					{
						active: false,
						ssid: "MySSID",
						signal: 70,
						security: "WPA2",
						freq: 2412,
					},
				],
				[
					"Other",
					{
						active: false,
						ssid: "Other",
						signal: 40,
						security: "WPA2",
						freq: 5180,
					},
				],
			]),
			saved: { MySSID: "uuid-myssid" },
		};
		addWifiInterface(MAC, wifiInterface);

		setWifiState({
			[MAC]: {
				...wifiInterface,
				available: new Map(wifiInterface.available),
				mode: "station",
			},
		});

		let broadcasts = 0;
		let lastDiff: StateDiff<WifiDiffEntry> | undefined;
		onWifiChange((diff) => {
			broadcasts++;
			lastDiff = diff;
		});

		handleWifiMonitorEvent({
			type: "connection-state",
			connection: "MySSID",
			state: "activated",
		});

		expect(broadcasts).toBe(1);
		expect(lastDiff?.changed.map((entry) => entry.mac)).toEqual([MAC]);

		const message = wifiBuildMsg() as Record<
			number,
			WifiInterfaceResponseMessage
		>;
		const entry = message[0];
		expect(entry?.conn).toBe("uuid-myssid");
		const connected = entry?.available?.find((net) => net.ssid === "MySSID");
		expect(connected?.active).toBe(true);
	});
});
