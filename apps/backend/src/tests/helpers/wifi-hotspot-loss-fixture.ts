import { afterEach, beforeEach, jest, spyOn } from "bun:test";
import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import * as time from "../../helpers/time.ts";
import { resetBootReadiness } from "../../modules/system/readiness.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../../modules/wifi/wifi-adapter-lock.ts";
import {
	notifyWifiAdapterModeDiscovery,
	wifiAdapterModeRestoreSource,
} from "../../modules/wifi/wifi-adapter-mode-events.ts";
import {
	defaultAdapterModeDeps,
	startWifiAdapterModeRestore,
} from "../../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
	wifiCancelScanRefresh,
} from "../../modules/wifi/wifi-connections.ts";
import { startHotspotLocked } from "../../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import {
	canHotspot,
	type WifiInterfaceWithHotspot,
} from "../../modules/wifi/wifi-hotspot-types.ts";
import { autoconnectFixture, MAC } from "./wifi-autoconnect-fixture.ts";

export function hotspotLossFixture() {
	const f = autoconnectFixture();
	let cancel: (() => void) | undefined;
	let acceptsActivation: boolean;
	let confirmsActivation: boolean;
	const attempts: string[] = [];
	const lockResults: boolean[] = [];

	function row(): WifiInterfaceWithHotspot {
		const current = getWifiInterfacesByMacAddress()[MAC];
		if (!current || !canHotspot(current)) throw new Error("Missing test radio");
		return current;
	}

	async function flush(): Promise<void> {
		for (let turn = 0; turn < 256; turn++) await Promise.resolve();
	}

	async function advance(ms = 3000): Promise<void> {
		jest.advanceTimersByTime(ms);
		await flush();
		wifiCancelScanRefresh();
	}

	async function startRestore(
		mode: WifiAdapterMode = "hotspot",
	): Promise<void> {
		f.row().supportsApStaConcurrency = mode === "hybrid";
		if (mode === "hybrid") f.row().conn = "station-link";
		f.persistMode(MAC, mode);
		await f.sample();
		let discovered = false;
		cancel = startWifiAdapterModeRestore(
			{
				...defaultAdapterModeDeps,
				readCapabilities: () => ({
					staApCombo: { supported: mode === "hybrid" },
				}),
				startHotspot: async (device, publishOutcome) => {
					const current = row();
					if (current.id !== device)
						return { success: false, error: "no-device" };
					attempts.push(current.ifname);
					const probe = await withWifiAdapterLock(
						wifiAdapterLockKey(MAC),
						async () => true,
					);
					lockResults.push(probe.success);
					const result = await startHotspotLocked(MAC, current, {
						...f.deps,
						publishOutcome,
						ensureConcurrentInterface: async () => ({
							ifname: `clap-${current.ifname}`,
							created: false,
						}),
						nmConnect: async (uuid) => {
							if (!acceptsActivation) return false;
							f.activations.push(uuid);
							f.list(
								mode === "hybrid"
									? [
											`${current.ifname}:wifi:connected:station-link`,
											`clap-${current.ifname}:wifi:connected:${uuid}`,
										]
									: [`${current.ifname}:wifi:connected:${uuid}`],
							);
							return true;
						},
					});
					if (confirmsActivation) settlePending(current.ifname, true);
					return result;
				},
			},
			{
				hasDiscovery: () => discovered,
				subscribe: (listener) =>
					wifiAdapterModeRestoreSource.subscribe(async () => {
						discovered = true;
						await listener();
					}),
			},
		);
		await notifyWifiAdapterModeDiscovery();
	}

	function lose(ifname = row().ifname): void {
		f.list([`${row().ifname}:wifi:disconnected:`]);
		handleWifiMonitorEvent({
			type: "device-state",
			device: ifname,
			state: "disconnected",
		});
	}

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(10_000);
		spyOn(time, "getms").mockImplementation(() => Date.now());
		acceptsActivation = true;
		confirmsActivation = true;
		attempts.length = 0;
		lockResults.length = 0;
		resetBootReadiness();
	});

	afterEach(() => {
		cancel?.();
		cancel = undefined;
		resetBootReadiness();
		jest.useRealTimers();
	});

	return {
		...f,
		row,
		startRestore,
		lose,
		advance,
		attempts,
		lockResults,
		get acceptsActivation() {
			return acceptsActivation;
		},
		set acceptsActivation(value: boolean) {
			acceptsActivation = value;
		},
		get confirmsActivation() {
			return confirmsActivation;
		},
		set confirmsActivation(value: boolean) {
			confirmsActivation = value;
		},
	};
}
