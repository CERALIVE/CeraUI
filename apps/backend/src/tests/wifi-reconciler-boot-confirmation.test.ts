import { expect, test } from "bun:test";
import { getBootReadiness } from "../modules/system/readiness.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { notifyWifiAdapterModeDiscovery } from "../modules/wifi/wifi-adapter-mode-events.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { transitionVirtualBinding } from "../modules/wifi/wifi-virtual-binding.ts";
import { MAC, PROFILE } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();

test.each(["hotspot", "hybrid"] as const)(
	"r5 accepted boot %s restoration retains bounded recovery after failed confirmation",
	async (mode) => {
		f.confirmsActivation = false;
		await f.startRestore(mode);
		for (let attempt = 0; attempt < 3; attempt++) {
			await settlePending(f.row().ifname, false);
			f.list(["wlan0:wifi:disconnected:"]);
			await f.advance();
		}
		for (let tick = 0; tick < 100; tick++) await f.advance();
		for (let edge = 0; edge < 4; edge++) await notifyWifiAdapterModeDiscovery();
		expect(f.attempts).toEqual(["wlan0", "wlan0", "wlan0"]);
		expect(observedWifiAdapterMode(f.row())).toBe("station");
		expect(getBootReadiness().degradedSubsystems).toEqual([
			`wifi-hotspot-restore:${MAC}`,
		]);
		f.confirmsActivation = true;
		settlePending(f.row().ifname, true);
		f.row().hotspot.conn = PROFILE;
		f.row().conn = f.row().hotspot.conn ?? null;
		if (mode === "hybrid")
			transitionVirtualBinding(f.row(), {
				kind: "set",
				ifname: "clap-wlan0",
				activeConn: PROFILE,
			});
		else {
			f.row().activeConn = PROFILE;
			f.row().activeMode = "ap";
		}
		await notifyWifiAdapterModeDiscovery();
		expect(getBootReadiness().degraded).toBe(false);
	},
);
