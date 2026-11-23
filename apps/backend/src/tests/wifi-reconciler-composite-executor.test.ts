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
import {
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
} from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { mockQualifiedHybridActivation } from "./helpers/wifi-hotspot-test-setup.ts";

const owner = `${MAC}@${PORT}`;
const other = "wlan1:wifi:disconnected:";
const f = {
	...autoconnectFixture(),
	row() {
		const row = getWifiInterfacesByMacAddress()[owner];
		if (!row || !canHotspot(row)) throw new Error("Missing verified twin");
		return row;
	},
};

test.each(["hotspot", "hybrid"] as const)(
	"r5 default executor restores composite %s intent with physical NM pins",
	async (mode) => {
		if (mode === "hybrid") mockQualifiedHybridActivation();
		const confirmed = Promise.withResolvers<void>();
		spyOn(defaultAdapterModeDeps, "publishHotspotOutcome").mockImplementation(
			(kind, _device, outcome) => {
				if (kind !== "start") return;
				if (outcome.success) confirmed.resolve();
				else
					confirmed.reject(new Error("Composite fixture confirmation refused"));
			},
		);
		resetHotspotCredentialsForTest();
		rememberHotspotCredentials(owner, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: PROFILE,
		});
		const profile = f.profiles.get(PROFILE);
		if (!profile) throw new Error("Missing fixture profile");
		profile["match.path"] = PORT;
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			mac: MAC,
			path: "usb-Composite:2.0",
		});
		f.list(["wlan0:wifi:disconnected:", other]);
		await f.discover();
		f.persistMode(owner, mode);
		f.row().conn = PROFILE;
		f.row().activeConn = PROFILE;
		f.row().activeMode = "ap";
		f.row().supportsApStaConcurrency = true;
		spyOn(defaultHotspotDeps, "readCapabilities").mockReturnValue({
			staApCombo: { supported: true },
		});
		spyOn(defaultHotspotDeps, "nmConnSetFields").mockImplementation(
			(uuid, fields) => nm.nmConnSetFields(uuid, fields),
		);
		spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(
			async (uuid, _timeout, activated) => {
				activated?.("/org/freedesktop/NetworkManager/ActiveConnection/1");
				f.activations.push(uuid);
				f.list(
					mode === "hybrid"
						? [
								"wlan0:wifi:connected:station-link",
								`clap-wlan0:wifi:connected:${uuid}`,
								other,
							]
						: [`wlan0:wifi:connected:${uuid}`, other],
				);
				return true;
			},
		);
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
		await confirmed.promise;
		expect(f.activations).toEqual([PROFILE]);
		expect(observedWifiAdapterMode(f.row())).toBe(mode);
		expect(getHotspotCredentials(owner)?.conn).toBe(PROFILE);
		expect(getHotspotCredentials(MAC)).toBeUndefined();
		expect(f.profiles.get(PROFILE)?.["802-11-wireless.mac-address"]).toBe(
			mode === "hotspot" ? MAC : "",
		);
	},
);
