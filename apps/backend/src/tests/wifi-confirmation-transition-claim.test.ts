import { afterEach, expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { MAC, PORT, PROFILE } from "./helpers/wifi-autoconnect-fixture.ts";
import { hotspotLossFixture } from "./helpers/wifi-hotspot-loss-fixture.ts";

const f = hotspotLossFixture();
afterEach(() => {
	delete f.deps.pollHotspotActive;
	delete f.deps.readCapabilities;
});
async function flush(): Promise<void> {
	for (let turn = 0; turn < 256; turn++) await Promise.resolve();
}

test("r8 an old poll cannot retire a replacement Start before confirmation registration", async () => {
	f.confirmsActivation = false;
	f.deps.readCapabilities = () => ({ staApCombo: { supported: true } });
	f.profiles.set("station-link", { "802-11-wireless.mode": "infrastructure" });
	f.witnesses.set("clap-wlan0", {
		ifindex: 4,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: PORT,
	});
	let rows = [
		"wlan0:wifi:connected:station-link",
		"clap-wlan0:wifi:disconnected:",
	];
	spyOn(nm, "nmDevices").mockImplementation(async () => [...rows]);
	const oldEntered = Promise.withResolvers<void>();
	const oldPoll = Promise.withResolvers<boolean>();
	const replacementEntered = Promise.withResolvers<void>();
	const replacementNm = Promise.withResolvers<boolean>();
	const replacementPollEntered = Promise.withResolvers<void>();
	const replacementPoll = Promise.withResolvers<boolean>();
	f.deps.pollHotspotActive = () => {
		oldEntered.resolve();
		return oldPoll.promise;
	};
	let replacement: ReturnType<typeof startHotspotForInterface> | undefined;
	try {
		await f.startRestore("hybrid");
		await oldEntered.promise;
		rows = ["wlan0:wifi:connected:station-link"];
		f.witnesses.delete("clap-wlan0");
		await f.discover();
		rows = [
			"wlan0:wifi:connected:station-link",
			"clap-wlan0:wifi:disconnected:",
		];
		f.witnesses.set("clap-wlan0", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
			path: PORT,
		});
		await f.discover();
		const oldProfile = f.profiles.get(PROFILE);
		if (!oldProfile) throw new Error("Missing original AP profile");
		f.profiles.set("replacement-ap", { ...oldProfile });
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: "replacement-ap",
		});
		f.row().hotspot.conn = "replacement-ap";
		f.deps.pollHotspotActive = () => {
			replacementPollEntered.resolve();
			return replacementPoll.promise;
		};
		replacement = startHotspotForInterface(MAC, f.row(), {
			...f.deps,
			nmConnect: async (uuid) => {
				f.activations.push(uuid);
				replacementEntered.resolve();
				return replacementNm.promise;
			},
		});
		await replacementEntered.promise;
		const attemptsBefore = f.attempts.length;
		oldPoll.resolve(false);
		await flush();
		const afterOldRetired = f.row().hotspot.transition ?? null;
		replacementNm.resolve(true);
		const accepted = await replacement;
		await replacementPollEntered.promise;
		await f.advance();

		expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toEqual({
			ifindex: 3,
			wiphy: 0,
			phyPath: "/sys/devices/policy/phy0",
		});
		expect({
			afterOldRetired,
			accepted,
			selected: f.row().hotspot.conn,
			binding: f.row().concurrentHotspot?.ifname,
			transition: f.row().hotspot.transition,
			mode: observedWifiAdapterMode(f.row()),
			attemptsBefore,
			attemptsAfter: f.attempts.length,
		}).toEqual({
			afterOldRetired: "activating",
			accepted: { success: true },
			selected: "replacement-ap",
			binding: "clap-wlan0",
			transition: "activating",
			mode: "station",
			attemptsBefore: 1,
			attemptsAfter: 1,
		});
		expect(f.activations).toEqual([PROFILE, "replacement-ap"]);
	} finally {
		oldPoll.resolve(false);
		replacementNm.resolve(true);
		replacementPoll.resolve(false);
		settlePending("wlan0", false);
		if (replacement) await replacement;
		await flush();
	}
});
