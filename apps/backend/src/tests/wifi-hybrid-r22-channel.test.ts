import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

for (const qualified of [true, false]) {
	test(`the hybrid channel consumer ${qualified ? "accepts MT7925" : "refuses hwsim"} with the captured shared group`, async () => {
		const f = await targetFixture();
		const dump = readFileSync(
			new URL("./fixtures/wifi/iw-phy-r22-phy0.txt", import.meta.url),
			"utf8",
		);
		const combination = dump
			.split("valid interface combinations:")[1]
			?.split("\n\tHT Capability overrides:")[0];
		if (!combination) throw new Error("Missing captured combination");
		f.combination(`valid interface combinations:${combination}`);
		f.frequency(2437, "", 6);
		if (!qualified) f.driver("mac80211_hwsim");
		const channel = await concurrent.readHybridStationChannel("wlan0");
		if (qualified) {
			expect(channel?.frequency).toBe(2437);
			expect(channel?.sameChannelOnly).toBe(true);
			expect(channel?.fields).toEqual({
				"802-11-wireless.band": "bg",
				"802-11-wireless.channel": "6",
			});
		} else expect(channel).toBeUndefined();
		expect(f.calls.filter((args) => args.includes("add"))).toEqual([]);
	});
}
