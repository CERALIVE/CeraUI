import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	markBootDegraded,
} from "../modules/system/readiness.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { MAC, PORT } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();
afterEach(() => {
	delete f.deps.pollHotspotActive;
	delete f.deps.readCapabilities;
});

test("r7 losing the virtual confirmation target retires its transition and exhausts recovery", async () => {
	f.confirmsActivation = false;
	f.witnesses.set("clap-wlan0", {
		ifindex: 4,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: PORT,
	});
	f.profiles.set("station-link", { "802-11-wireless.mode": "infrastructure" });
	let rows = [
		"wlan0:wifi:connected:station-link",
		"clap-wlan0:wifi:disconnected:",
	];
	spyOn(nm, "nmDevices").mockImplementation(async () => [...rows]);
	const poll = defaultHotspotDeps.pollHotspotActive;
	if (!poll) throw new Error("Missing production confirmation poll");
	f.deps.readCapabilities = () => ({ staApCombo: { supported: true } });
	let observations = 0;
	f.deps.pollHotspotActive = async (iface) => {
		const up = await poll(iface);
		if (++observations === 1) {
			rows = ["wlan0:wifi:connected:station-link"];
			f.witnesses.delete("clap-wlan0");
			await f.discover();
		}
		return up;
	};
	markBootDegraded("unrelated");
	await f.startRestore("hybrid");
	for (let tick = 0; tick < 160; tick++) await f.advance(2000);

	expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toEqual({
		ifindex: 3,
		wiphy: 0,
		phyPath: "/sys/devices/policy/phy0",
	});
	expect({
		attempts: f.attempts.length,
		transition: f.row().hotspot.transition ?? null,
		binding: f.row().concurrentHotspot?.ifname ?? null,
		timers: jest.getTimerCount(),
	}).toEqual({ attempts: 3, transition: null, binding: null, timers: 0 });
	expect(f.activations).toEqual(["policy-ap", "policy-ap", "policy-ap"]);
	expect(getBootReadiness().degradedSubsystems).toEqual([
		"unrelated",
		`wifi-hotspot-restore:${MAC}`,
	]);
});
