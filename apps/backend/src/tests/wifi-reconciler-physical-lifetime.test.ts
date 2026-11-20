import { expect, test } from "bun:test";
import { getBootReadiness } from "../modules/system/readiness.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	notifyWifiAdapterModeDiscovery,
	notifyWifiAdapterModeEdge,
} from "../modules/wifi/wifi-adapter-mode-events.ts";
import { handleWifiMonitorEvent } from "../modules/wifi/wifi-connections.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { MAC, PORT } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();

test.each(["hotspot", "hybrid"] as const)(
	"r5 availability token churn cannot refill exhausted %s recovery",
	async (mode) => {
		await f.startRestore(mode);
		f.acceptsActivation = false;
		f.lose(mode === "hybrid" ? "clap-wlan0" : "wlan0");
		await notifyWifiAdapterModeEdge();
		await f.advance();
		await f.advance();
		expect(f.attempts).toHaveLength(4);
		const original = wifiRadioIdentity.state.rows.get("wlan0");
		for (let flap = 0; flap < 5; flap++) {
			handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state: "unavailable",
			});
			await f.sample();
			await notifyWifiAdapterModeDiscovery();
		}
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.incarnation).not.toBe(
			original?.incarnation,
		);
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toEqual(
			original?.lifetime,
		);
		expect(f.attempts).toHaveLength(4);
		expect(getBootReadiness().degradedSubsystems).toEqual([
			`wifi-hotspot-restore:${MAC}`,
		]);
		f.acceptsActivation = true;
		f.witnesses.set("wlan0", {
			ifindex: 9,
			phy: "/sys/devices/policy/reprobed/phy0",
			mac: MAC,
			path: PORT,
		});
		await f.discover();
		await notifyWifiAdapterModeEdge();
		expect(f.attempts).toHaveLength(5);
		expect(observedWifiAdapterMode(f.row())).toBe(mode);
		expect(getBootReadiness().degraded).toBe(false);
	},
);
