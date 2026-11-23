import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	defaultAdapterModeDeps,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { wifiCancelScanRefresh } from "../modules/wifi/wifi-connections.ts";
import { startHotspotLocked } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { advancePolicy } from "./helpers/wifi-reconcile-fixture.ts";

const f = autoconnectFixture();
afterEach(() => {
	resetBootReadiness();
	jest.useRealTimers();
});

test("r4 boot activation failures exhaust three scheduled attempts without spinning", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(10_000);
	spyOn(time, "getms").mockImplementation(() => Date.now());
	f.persistMode(MAC, "hotspot");
	const write = nm.nmConnSetFields;
	let attempts = 0;
	spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
		fields["802-11-wireless.mac-address"] !== undefined
			? Promise.resolve(false)
			: write(uuid, fields),
	);
	let discovered = false;
	const cancel = startWifiAdapterModeRestore(
		{
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: false } }),
			startHotspot: async () => {
				attempts++;
				return startHotspotLocked(MAC, f.row(), f.deps);
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
	try {
		await f.discover();
		await advancePolicy(0);
		wifiCancelScanRefresh();
		for (let tick = 0; tick < 102; tick++) {
			await advancePolicy(3000);
			wifiCancelScanRefresh();
		}
		expect(attempts).toBe(3);
		expect(getBootReadiness().degradedSubsystems).toEqual([
			`wifi-hotspot-restore:${MAC}`,
		]);
		expect(jest.getTimerCount()).toBe(0);
		await advancePolicy(300_000);
		expect(attempts).toBe(3);
	} finally {
		cancel();
	}
});

test.each([false, true])(
	"r4 adversarial3 boot restore retries a rejected binding, hybrid=%s",
	async (hybrid) => {
		jest.useFakeTimers();
		jest.setSystemTime(10_000);
		spyOn(time, "getms").mockImplementation(() => Date.now());
		f.seed(hybrid);
		f.persistMode(MAC, hybrid ? "hybrid" : "hotspot");
		const write = nm.nmConnSetFields;
		let bindings = 0;
		spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) => {
			if (
				fields["802-11-wireless.mac-address"] !== undefined &&
				++bindings === 1
			)
				return Promise.resolve(false);
			return write(uuid, fields);
		});
		let discovered = false;
		const cancel = startWifiAdapterModeRestore(
			{
				...defaultAdapterModeDeps,
				readCapabilities: () => ({ staApCombo: { supported: hybrid } }),
				startHotspot: async () => {
					const result = await startHotspotLocked(MAC, f.row(), f.deps);
					settlePending(f.row().ifname, true);
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
		try {
			await f.discover();
			await advancePolicy(0);
			expect(bindings).toBe(1);
			expect(f.activations).toEqual([]);
			await advancePolicy(3000);
			expect(bindings).toBe(2);
			expect(f.activations).toEqual([PROFILE]);
			expect(observedWifiAdapterMode(f.row())).toBe(
				hybrid ? "hybrid" : "hotspot",
			);
			expect(getBootReadiness().degraded).toBe(false);
		} finally {
			cancel();
		}
	},
);
