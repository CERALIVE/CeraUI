import { expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();

test.each(["hotspot", "hybrid"] as const)(
	"r5 default executor restores composite %s intent with physical NM pins",
	async (mode) => {
		const owner = `${MAC}@phy0`;
		resetHotspotCredentialsForTest();
		rememberHotspotCredentials(owner, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: PROFILE,
		});
		f.persistMode(owner, mode);
		f.row().conn = PROFILE;
		f.row().activeConn = PROFILE;
		f.row().activeMode = "ap";
		f.row().supportsApStaConcurrency = true;
		await f.sample();
		spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue({
			staApCombo: { supported: true },
		});
		spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(
			(uuid, fields) => nm.nmConnSetFields(uuid, fields),
		);
		spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async (uuid) => {
			f.activations.push(uuid);
			f.list(
				mode === "hybrid"
					? [
							"wlan0:wifi:connected:station-link",
							`clap-wlan0:wifi:connected:${uuid}`,
						]
					: [`wlan0:wifi:connected:${uuid}`],
			);
			return true;
		});
		spyOn(defaultHotspotDeps, "pollHotspotActive").mockResolvedValue(true);
		spyOn(defaultHotspotDeps, "pruneHotspotConns").mockResolvedValue();
		spyOn(defaultHotspotDeps, "ensureConcurrentInterface").mockResolvedValue({
			ifname: "clap-wlan0",
			created: false,
		});
		handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "disconnected",
		});
		await reconcileWifiAdapterModes({
			...defaultAdapterModeDeps,
			readCapabilities: () => ({ staApCombo: { supported: true } }),
		});
		for (let turn = 0; turn < 256; turn++) await Promise.resolve();
		expect(f.activations).toEqual([PROFILE]);
		expect(observedWifiAdapterMode(f.row())).toBe(mode);
		expect(getHotspotCredentials(owner)?.conn).toBe(PROFILE);
		expect(getHotspotCredentials(MAC)).toBeUndefined();
		expect(f.profiles.get(PROFILE)?.["802-11-wireless.mac-address"]).toBe(
			mode === "hotspot" ? MAC : "",
		);
	},
);
